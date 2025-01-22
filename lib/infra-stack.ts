import * as cdk from 'aws-cdk-lib';
import { CfnEIP, CfnInternetGateway, CfnNatGateway, CfnRoute, CfnVPCGatewayAttachment, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class ExpenseTrackerServicesDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a Virtual Private Cloud (VPC)
    const vpc = new Vpc(this, "myVPC", {
      vpcName: "expenseTracker", // Name of the VPC
      cidr: "10.0.0.0/16", // CIDR block for the VPC
      maxAzs: 2, // Maximum number of Availability Zones (AZs) to use
      natGateways: 2, // Number of NAT Gateways to create
      createInternetGateway: false, // We will create an Internet Gateway manually
      subnetConfiguration: [
        {
          cidrMask: 24, // CIDR block size for public subnets
          name: 'public-subnet', // Name for public subnets
          subnetType: SubnetType.PUBLIC, // Public subnets will have direct internet access
        },
        {
          cidrMask: 24, // CIDR block size for private subnets
          name: 'private-subnet', // Name for private subnets
          subnetType: SubnetType.PRIVATE_WITH_EGRESS, // Private subnets with NAT Gateway for internet access
        }
      ]
    });

    // Create an Internet Gateway to allow public internet access
    const internetGateway = new CfnInternetGateway(this, 'InternetGateway');
    new CfnVPCGatewayAttachment(this, 'MyUniqueVPCGatewayAttachment', {
      vpcId: vpc.vpcId, // Attach the Internet Gateway to the VPC
      internetGatewayId: internetGateway.ref, // Reference to the Internet Gateway
    });

    // Create NAT Gateways for private subnets to access the internet
    const natGatewayOne = new CfnNatGateway(this, 'NatGatewayOne', {
      subnetId: vpc.publicSubnets[0].subnetId, // Attach the first NAT Gateway to the first public subnet
      allocationId: new CfnEIP(this, 'EIPForNatGatewayOne').attrAllocationId, // Allocate an Elastic IP for the NAT Gateway
    });

    const natGatewayTwo = new CfnNatGateway(this, 'NatGatewayTwo', {
      subnetId: vpc.publicSubnets[1].subnetId, // Attach the second NAT Gateway to the second public subnet
      allocationId: new CfnEIP(this, 'EIPForNatGatewayTwo').attrAllocationId, // Allocate an Elastic IP for the NAT Gateway
    });

    // Create routes for private subnets to use the NAT Gateways for internet traffic
    vpc.privateSubnets.forEach((subnet, index) => {
      new CfnRoute(this, `PrivateRouteToNatGateway-${index}`, {
        routeTableId: subnet.routeTable.routeTableId, // Route table ID for the private subnet
        destinationCidrBlock: '0.0.0.0/0', // Route all traffic to the internet
        natGatewayId: index === 0 ? natGatewayOne.ref : natGatewayTwo.ref, // Use the appropriate NAT Gateway
      });
    });

    // Create routes for public subnets to use the Internet Gateway for internet traffic
    vpc.publicSubnets.forEach((subnet, index) => {
      new CfnRoute(this, `PublicRouteToInternetGateway-${index}`, {
        routeTableId: subnet.routeTable.routeTableId, // Route table ID for the public subnet
        destinationCidrBlock: '0.0.0.0/0', // Route all traffic to the internet
        gatewayId: internetGateway.ref // Use the Internet Gateway
      });
    });

    // Export the VPC ID as an SSM Parameter for other applications to use
    new cdk.aws_ssm.StringParameter(this, 'VpcIdExport', {
      parameterName: 'VpcId', // Parameter name
      stringValue: vpc.vpcId // VPC ID value
    });

    // Export each public subnet ID as SSM Parameters for easy reference
    vpc.publicSubnets.forEach((subnet, index) => {
      new cdk.aws_ssm.StringParameter(this, `PublicSubnetExport-${index}`, {
        parameterName: `PublicSubnet-${index}`, // Parameter name
        stringValue: subnet.subnetId // Public subnet ID value
      });
    });

    // Export each private subnet ID as SSM Parameters for easy reference
    vpc.privateSubnets.forEach((subnet, index) => {
      new cdk.aws_ssm.StringParameter(this, `PrivateSubnetExport-${index}`, {
        parameterName: `PrivateSubnet-${index}`, // Parameter name
        stringValue: subnet.subnetId // Private subnet ID value
      });
    });
  }
}
