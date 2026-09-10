// CloudFormation source. Emits JSON; never deploys or changes client config.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ref = Ref => ({ Ref });
const sub = value => ({ 'Fn::Sub': value });
const attr = (id, key) => ({ 'Fn::GetAtt': [id, key] });
const retained = { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' };
const tags = [{ Key: 'Application', Value: 'Opusloops' }, { Key: 'Migration', Value: 'supabase-to-aws' }];
const resources = {
  DatabaseClientSecurityGroup: {
    Type: 'AWS::EC2::SecurityGroup',
    Properties: {
      GroupDescription: 'Only the private Opusloops database bridge connects to PostgreSQL',
      VpcId: ref('VpcId'),
      SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, CidrIp: ref('VpcCidr') }],
      Tags: tags,
    },
  },
  DatabaseSecurityGroup: {
    Type: 'AWS::EC2::SecurityGroup',
    Properties: {
      GroupDescription: 'Private Opusloops PostgreSQL, no public ingress', VpcId: ref('VpcId'),
      SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: ref('DatabaseClientSecurityGroup') }],
      SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 1, ToPort: 1, CidrIp: '127.0.0.1/32' }],
      Tags: tags,
    },
  },
  DatabaseSubnetGroup: {
    Type: 'AWS::RDS::DBSubnetGroup',
    Properties: { DBSubnetGroupDescription: 'Opusloops database in the existing worker VPC', SubnetIds: ref('SubnetIds'), Tags: tags },
  },
  DatabaseParameters: {
    Type: 'AWS::RDS::DBParameterGroup',
    Properties: { Family: 'postgres17', Description: 'Opusloops TLS-only PostgreSQL 17', Parameters: { 'rds.force_ssl': '1' }, Tags: tags },
  },
  Database: {
    Type: 'AWS::RDS::DBInstance', ...retained,
    Properties: {
      DBInstanceIdentifier: 'opusloops-postgres', DBName: 'opusloops', Engine: 'postgres',
      EngineVersion: ref('PostgresVersion'), DBInstanceClass: ref('DatabaseClass'),
      DBSubnetGroupName: ref('DatabaseSubnetGroup'), DBParameterGroupName: ref('DatabaseParameters'),
      VPCSecurityGroups: [ref('DatabaseSecurityGroup')], PubliclyAccessible: false,
      StorageEncrypted: true, StorageType: 'gp3', AllocatedStorage: '20', MaxAllocatedStorage: 100,
      MasterUsername: 'opusloops_admin', ManageMasterUserPassword: true,
      EnableIAMDatabaseAuthentication: true, BackupRetentionPeriod: 14,
      CopyTagsToSnapshot: true, DeletionProtection: true, AutoMinorVersionUpgrade: true,
      MultiAZ: false, Tags: tags,
    },
  },
  UserPool: {
    Type: 'AWS::Cognito::UserPool', ...retained,
    Properties: {
      UserPoolName: 'opusloops', DeletionProtection: 'ACTIVE', UserPoolTier: 'LITE',
      UsernameConfiguration: { CaseSensitive: false }, AliasAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
      MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      Policies: { PasswordPolicy: { MinimumLength: 8, RequireLowercase: false, RequireUppercase: false, RequireNumbers: false, RequireSymbols: false, TemporaryPasswordValidityDays: 3 } },
      Schema: [
        { Name: 'email', AttributeDataType: 'String', Required: true, Mutable: true },
        { Name: 'name', AttributeDataType: 'String', Required: false, Mutable: true },
        { Name: 'opusloops_id', AttributeDataType: 'String', Mutable: false, StringAttributeConstraints: { MinLength: '36', MaxLength: '36' } },
      ],
      UserPoolTags: { Application: 'Opusloops', Migration: 'supabase-to-aws' },
    },
  },
  UserPoolClient: {
    Type: 'AWS::Cognito::UserPoolClient',
    Properties: {
      ClientName: 'opusloops-web', UserPoolId: ref('UserPool'), GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true,
      ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      AccessTokenValidity: 60, IdTokenValidity: 60, RefreshTokenValidity: 30,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
      ReadAttributes: ['email', 'email_verified', 'name', 'custom:opusloops_id'],
      // Clients must never assign the legacy owner ID or membership themselves.
      WriteAttributes: ['email', 'name'],
    },
  },
  CallbackSecret: {
    Type: 'AWS::SecretsManager::Secret', ...retained,
    Properties: {
      Name: 'opusloops/aws-backend/worker-callback',
      Description: 'New AWS worker callback HMAC master, never exposed to browser or Batch tasks',
      GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true }, Tags: tags,
    },
  },
  UserImportRole: {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'cognito-idp.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
      Policies: [{ PolicyName: 'ImportResultsOnly', PolicyDocument: { Version: '2012-10-17', Statement: [{
        Effect: 'Allow', Action: ['logs:CreateLogGroup','logs:CreateLogStream','logs:DescribeLogStreams','logs:PutLogEvents'],
        Resource: sub('arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/cognito/userpools/${UserPool}/*'),
      }] } }], Tags: tags,
    },
  },
};

for (const [logicalId, suffix] of [['Uploads', 'uploads'], ['Sources', 'sources'], ['Artifacts', 'artifacts'], ['Migration', 'migration']]) {
  const id = `${logicalId}Bucket`;
  resources[id] = {
    Type: 'AWS::S3::Bucket', ...retained,
    Properties: {
      BucketName: sub(`opusloops-${suffix}-\${AWS::AccountId}-\${AWS::Region}`),
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: { Rules: [{ Id: 'AbortIncompleteUploads', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }] },
      ...(logicalId === 'Migration' ? {} : {
        NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: true } },
        CorsConfiguration: { CorsRules: [{
          AllowedOrigins: ['https://opusloops.com', 'https://www.opusloops.com', 'https://main.d1zc92wmtmvg23.amplifyapp.com', 'http://127.0.0.1:4173'],
          AllowedMethods: ['GET', 'HEAD', ...(logicalId === 'Uploads' ? ['PUT'] : [])],
          AllowedHeaders: ['content-type', 'range', 'if-none-match', 'x-amz-*'],
          ExposedHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'x-amz-checksum-sha256'], MaxAge: 300,
        }] },
      }),
      Tags: tags,
    },
  };
  resources[`${id}Policy`] = {
    Type: 'AWS::S3::BucketPolicy',
    Properties: { Bucket: ref(id), PolicyDocument: { Version: '2012-10-17', Statement: [{
      Sid: 'RequireTLS', Effect: 'Deny', Principal: '*', Action: 's3:*',
      Resource: [attr(id, 'Arn'), sub(`\${${id}.Arn}/*`)], Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    }, ...(logicalId === 'Migration' ? [] : [{
      Sid: 'RequireImmutableObjectCreation', Effect: 'Deny', Principal: '*', Action: 's3:PutObject',
      Resource: sub(`\${${id}.Arn}/*`),
      // Multipart parts do not accept this header; completion does. Protect the
      // final object without denying CreateMultipartUpload/UploadPart requests.
      Condition: { Null: { 's3:if-none-match': 'true' }, Bool: { 's3:ObjectCreationOperation': 'true' } },
    }])] } },
  };
}

export const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Opusloops native AWS data foundation. Does not switch production or delete Supabase.',
  Parameters: {
    VpcId: { Type: 'AWS::EC2::VPC::Id' }, SubnetIds: { Type: 'List<AWS::EC2::Subnet::Id>' },
    VpcCidr: { Type: 'String', AllowedPattern: '^([0-9]{1,3}\\.){3}[0-9]{1,3}/[0-9]{1,2}$' },
    PostgresVersion: { Type: 'String', Default: '17.6', AllowedPattern: '^17\\.[0-9]+$' },
    DatabaseClass: { Type: 'String', Default: 'db.t4g.micro', AllowedValues: ['db.t4g.micro', 'db.t4g.small', 'db.t4g.medium'] },
  },
  Resources: resources,
  Outputs: {
    DatabaseHost: { Value: attr('Database', 'Endpoint.Address') },
    DatabaseResourceId: { Value: attr('Database', 'DbiResourceId') },
    DatabaseSecretArn: { Value: attr('Database', 'MasterUserSecret.SecretArn') },
    DatabaseClientSecurityGroup: { Value: ref('DatabaseClientSecurityGroup') },
    UserPoolId: { Value: ref('UserPool') }, UserPoolClientId: { Value: ref('UserPoolClient') },
    CallbackSecretArn: { Value: ref('CallbackSecret') },
    UserImportRoleArn: { Value: attr('UserImportRole','Arn') },
    ...Object.fromEntries(['Uploads', 'Sources', 'Artifacts', 'Migration'].map(id => [`${id}Bucket`, { Value: ref(`${id}Bucket`) }])),
  },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(template, null, 2));
