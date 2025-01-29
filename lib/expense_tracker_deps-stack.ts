import * as cdk from 'aws-cdk-lib';
import { Peer, Port, SecurityGroup, Subnet, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AwsLogDriverMode, Cluster, ContainerImage, FargateService, FargateTaskDefinition, LogDrivers } from 'aws-cdk-lib/aws-ecs';
import { NetworkLoadBalancer, NetworkTargetGroup, Protocol, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export class ExpenseTrackerServices extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Retrieve the VPC ID from AWS Systems Manager Parameter Store
        const vpcId = cdk.aws_ssm.StringParameter.valueFromLookup(this, 'VpcId');

        // Import the existing VPC using the retrieved VPC ID
        const vpc = Vpc.fromLookup(this, "VpcImported", {
            vpcId: vpcId
        });

        // Import two private subnets using their IDs from Parameter Store
        const privateSubnet1 = Subnet.fromSubnetId(this, 'PrivateSubnet1', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PrivateSubnet-0'));
        const privateSubnet2 = Subnet.fromSubnetId(this, 'PrivateSubnet2', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PrivateSubnet-1'));

        // Create a security group for database and Kafka services to control network traffic
        const dbSecurityGroup = new SecurityGroup(this, 'DbSecurityGroup', {
            vpc,
            allowAllOutbound: true, // Allow all outbound traffic from this security group
        });

        // Allow MySQL, Kafka, and Zookeeper traffic within the VPC
        dbSecurityGroup.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(3306), 'Allow MySQL traffic');
        dbSecurityGroup.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(9092), 'Allow Kafka traffic');
        dbSecurityGroup.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(2181), 'Allow Kafka to access Zookeeper');

        // Create an ECS cluster for managing Fargate services
        const cluster = new Cluster(this, 'DatabaseKafkaCluster', {
            vpc,
            defaultCloudMapNamespace: {
                name: 'local', // Service discovery namespace
            },
        });

        // Create a Network Load Balancer (NLB) for handling traffic between services
        const nlb = new NetworkLoadBalancer(this, 'DatabaseNLB', {
            vpc,
            internetFacing: false, // Internal-only load balancer
            vpcSubnets: { subnets: [privateSubnet1, privateSubnet2] },
        });

        // Define a Fargate task definition for MySQL
        const mysqlTaskDefination = new FargateTaskDefinition(this, 'MySQLTaskDef');
        mysqlTaskDefination.addContainer('MySQLContainer', {
            image: ContainerImage.fromRegistry('mysql:8.3.0'), // Use MySQL 8.3 image from Docker Hub
            environment: {
                MYSQL_ROOT_PASSWORD: '12345',
                MYSQL_USER: 'user',
                MYSQL_PASSWORD: '12345',
                MYSQL_ROOT_USER: 'root'
            },
            logging: LogDrivers.awsLogs({
                streamPrefix: 'MySql', // Prefix for CloudWatch log streams
                mode: AwsLogDriverMode.NON_BLOCKING, // Non-blocking logging mode
                maxBufferSize: cdk.Size.mebibytes(25) // Max buffer size for logs
            }),
            portMappings: [{ containerPort: 3306 }], // Map container port 3306 for MySQL
        });

        // Define a Fargate task definition for Zookeeper
        const zookeeperTaskDefination = new FargateTaskDefinition(this, 'ZookeeperTaskDef', {
            memoryLimitMiB: 512, // Memory limit for the task
            cpu: 256, // CPU units for the task
        });

        zookeeperTaskDefination.addContainer('ZookeeperContainer', {
            image: ContainerImage.fromRegistry('confluentinc/cp-zookeeper:7.4.4'), // Use Confluent Zookeeper image
            environment: {
                ZOOKEEPER_CLIENT_PORT: '2181',
                ZOOKEEPER_TICK_TIME: '2000'
            },
            portMappings: [{ containerPort: 2181 }], // Map container port 2181 for Zookeeper
            logging: LogDrivers.awsLogs({
                streamPrefix: 'Zookeeper', // Prefix for CloudWatch log streams
                mode: AwsLogDriverMode.NON_BLOCKING,
                maxBufferSize: cdk.Size.mebibytes(25)
            })
        });

        // Define a Fargate task definition for Kafka
        const kafkaTaskDefination = new FargateTaskDefinition(this, 'KafkaTaskDef', {
            memoryLimitMiB: 1024,
            cpu: 512,
        });

        kafkaTaskDefination.addContainer('KafkaContainer', {
            image: ContainerImage.fromRegistry('confluentinc/cp-kafka:7.4.4'),
            environment: {
                KAFKA_BROKER_ID: "1",
                KAFKA_ZOOKEEPER_CONNECT: 'zookeeper-service.local:2181',
                KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${nlb.loadBalancerDnsName}:9092`,
                KAFKA_LISTENERS: 'PLAINTEXT://:9092',
                KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'PLAINTEXT:PLAINTEXT',
                KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
                KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
                KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true',
                KAFKA_NUM_PARTITIONS: '3',
                KAFKA_DEFAULT_REPLICATION_FACTOR: '1',
                KAFKA_MIN_INSYNC_REPLICAS: '1',
                KAFKA_UNCLEAN_LEADER_ELECTION_ENABLE: 'false',
                KAFKA_BROKER_RACK: 'RACK1'
            },
            portMappings: [
                { containerPort: 9092 }],
            logging: LogDrivers.awsLogs({
                streamPrefix: 'Kafka',
                mode: AwsLogDriverMode.NON_BLOCKING,
                maxBufferSize: cdk.Size.mebibytes(25)
            })
        });

        // Create Fargate services for MySQL, Zookeeper, and Kafka
        const mysqlService = new FargateService(this, 'MySQLService', {
            cluster,
            taskDefinition: mysqlTaskDefination,
            desiredCount: 1, // Run 1 MySQL container
            securityGroups: [dbSecurityGroup],
            vpcSubnets: { subnets: [privateSubnet1, privateSubnet2] },
            enableExecuteCommand: true, // Enable remote execution for MySQL service
        });

        const zookeeperService = new FargateService(this, 'ZookeeperService', {
            cluster,
            taskDefinition: zookeeperTaskDefination,
            desiredCount: 3, // Run 3 Zookeeper containers
            securityGroups: [dbSecurityGroup],
            vpcSubnets: { subnets: [privateSubnet1, privateSubnet2] },
            cloudMapOptions: {
                name: 'zookeeper-service' // Register Zookeeper service for discovery
            },
        });

        const kafkaService = new FargateService(this, 'KafkaService', {
            cluster,
            taskDefinition: kafkaTaskDefination,
            desiredCount: 3,
            securityGroups: [dbSecurityGroup],
            vpcSubnets: { subnets: [privateSubnet1, privateSubnet2] },
            cloudMapOptions: {
                name: 'kafka-service'
            }
        });

        // Create target groups for MySQL and Kafka services
        const mysqlTargetGroup = new NetworkTargetGroup(this, 'MySQLTargetGroup', {
            vpc,
            port: 3306,
            protocol: Protocol.TCP, // Use TCP protocol for MySQL
            targetType: TargetType.IP
        });

        const kafkaTargetGroup = new NetworkTargetGroup(this, 'KafkaTargetGroup', {
            vpc,
            port: 9092,
            protocol: Protocol.TCP, // Use TCP protocol for Kafka
            targetType: TargetType.IP,
        });

        // Associate services with their respective target groups
        mysqlTargetGroup.addTarget(mysqlService);
        kafkaTargetGroup.addTarget(kafkaService);

        // Add listeners to the NLB for MySQL and Kafka
        nlb.addListener('MySQLListener', {
            port: 3306,
            protocol: Protocol.TCP,
            defaultTargetGroups: [mysqlTargetGroup],
        });

        nlb.addListener('KafkaListener', {
            port: 9092,
            protocol: Protocol.TCP,
            defaultTargetGroups: [kafkaTargetGroup],
        });

        // Store the NLB DNS name in AWS Systems Manager Parameter Store for reference
        new cdk.aws_ssm.StringParameter(this, `ExpenseTrackerServicesNLB`, {
            parameterName: `ExpenseTrackerServicesNLB`,
            stringValue: nlb.loadBalancerDnsName
        })
    }
}
