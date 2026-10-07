targetScope = 'resourceGroup'

@description('Deploy ACA resources only after the storage, registry, and vault prerequisites exist.')
param enableApps bool = false

@description('Azure region. The production design uses East Asia.')
param location string = 'eastasia'

@description('Immutable ACR image reference, including @sha256 digest, required when enableApps is true.')
param imageDigest string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Stable signing key identifier embedded in signed releases.')
param signingKeyId string = 'government-feed-2026'

@description('Object ID of the GitHub OIDC deployment service principal. It is granted ACR push and Key Vault secret write roles.')
param deploymentPrincipalObjectId string = ''

@description('Enable emergency-medical coverage only after both versioned roster and reviewed crosswalk files exist in the private share.')
param emergencyMedicalRosterConfigured bool = false

@description('Prefix used to derive globally unique Azure resource names.')
param namePrefix string = 'resilientgeo'

var suffix = uniqueString(resourceGroup().id)
var storageName = take('${toLower(replace(namePrefix, '-', ''))}${suffix}', 24)
var registryName = take('${toLower(replace(namePrefix, '-', ''))}${suffix}', 50)
var vaultName = take('${toLower(replace(namePrefix, '-', ''))}${suffix}', 24)
var environmentName = '${take(namePrefix, 15)}-aca-${take(suffix, 8)}'
var roleAcrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var roleBlobReader = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var roleBlobContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var roleKeyVaultSecretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var roleAcrPush = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
var roleKeyVaultSecretsOfficer = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
var privateSharePath = '/var/lib/resilientgeo-private'
var publicSharePath = '/var/lib/resilientgeo-public'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource privateShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'resilientgeo-private'
  properties: { shareQuota: 100 }
}

resource publicShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'resilientgeo-public'
  properties: { shareQuota: 100 }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource controlContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'resilientgeo-control'
  properties: { publicAccess: 'None' }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: { name: 'Standard' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    accessPolicies: []
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${take(namePrefix, 20)}-logs-${take(suffix, 6)}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource privateMount 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'private-share'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: privateShare.name
      accessMode: 'ReadWrite'
    }
  }
}

resource publicReadWriteMount 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'public-share-rw'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: publicShare.name
      accessMode: 'ReadWrite'
    }
  }
}

resource publicReadOnlyMount 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'public-share-ro'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: publicShare.name
      accessMode: 'ReadOnly'
    }
  }
}

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableApps) {
  name: '${namePrefix}-api-identity'
  location: location
}

resource collectorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableApps) {
  name: '${namePrefix}-collector-identity'
  location: location
}

resource cleanupIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableApps) {
  name: '${namePrefix}-cleanup-identity'
  location: location
}

var sharedCollectorEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'AZURE_CLIENT_ID', value: collectorIdentity.properties.clientId }
  { name: 'PRIVATE_DATA_ROOT', value: privateSharePath }
  { name: 'PUBLIC_RELEASE_ROOT', value: publicSharePath }
  { name: 'AREA_CATALOG_PATH', value: '${privateSharePath}/area-catalog.json' }
  { name: 'SIGNING_KEY_ID', value: signingKeyId }
  { name: 'AZURE_STORAGE_BLOB_ENDPOINT', value: storage.properties.primaryEndpoints.blob }
  { name: 'AZURE_CONTROL_CONTAINER', value: controlContainer.name }
  { name: 'AZURE_RELEASE_POINTER_BLOB', value: 'current/release-pointer.json' }
  { name: 'AZURE_COLLECTOR_LOCK_BLOB', value: 'locks/collector.lock' }
]

var collectorVolumes = [
  { name: 'private-share', storageType: 'AzureFile', storageName: privateMount.name }
  { name: 'public-share', storageType: 'AzureFile', storageName: publicReadWriteMount.name }
]

var collectorMounts = [
  { volumeName: 'private-share', mountPath: privateSharePath }
  { volumeName: 'public-share', mountPath: publicSharePath }
]

var secretDefinitionsCollector = [
  { name: 'signing-private-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/signing-private-key-pem', identity: collectorIdentity.id }
  { name: 'signing-public-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/signing-public-key-pem', identity: collectorIdentity.id }
  { name: 'cwa-api-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/cwa-api-key', identity: collectorIdentity.id }
  { name: 'ncdr-api-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/ncdr-api-key', identity: collectorIdentity.id }
]

var collectorSecretEnv = [
  { name: 'SIGNING_PRIVATE_KEY_PEM', secretRef: 'signing-private-key' }
  { name: 'SIGNING_PUBLIC_KEY_PEM', secretRef: 'signing-public-key' }
  { name: 'CWA_API_KEY', secretRef: 'cwa-api-key' }
  { name: 'NCDR_ALERT_API_KEY', secretRef: 'ncdr-api-key' }
]

var emergencyMedicalEnv = emergencyMedicalRosterConfigured ? [
  { name: 'EMERGENCY_MEDICAL_ROSTER_PATH', value: '${privateSharePath}/config/emergency-medical-roster.json' }
  { name: 'EMERGENCY_MEDICAL_CROSSWALK_PATH', value: '${privateSharePath}/config/emergency-medical-crosswalk.json' }
] : []

resource api 'Microsoft.App/containerApps@2024-03-01' = if (enableApps) {
  name: '${namePrefix}-api'
  location: location
  dependsOn: [apiAcrPull, apiBlobRead, apiVaultSecrets]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${apiIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [
        { name: 'signing-public-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/signing-public-key-pem', identity: apiIdentity.id }
      ]
      registries: [{ server: registry.properties.loginServer, identity: apiIdentity.id }]
      ingress: {
        external: true
        targetPort: 8787
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      scale: { minReplicas: 0, maxReplicas: 2, rules: [] }
      volumes: [
        { name: 'public-share', storageType: 'AzureFile', storageName: publicReadOnlyMount.name }
      ]
      containers: [{
        name: 'api'
        image: imageDigest
        command: ['node', '/app/deploy/api-entrypoint.mjs', 'node', '/app/server/src/api-entrypoint.mjs']
        resources: { cpu: 0.5, memory: '1Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'PUBLIC_RELEASE_ROOT', value: publicSharePath }
          { name: 'SIGNING_KEY_ID', value: signingKeyId }
          { name: 'AZURE_CLIENT_ID', value: apiIdentity.properties.clientId }
          { name: 'AZURE_STORAGE_BLOB_ENDPOINT', value: storage.properties.primaryEndpoints.blob }
          { name: 'AZURE_CONTROL_CONTAINER', value: controlContainer.name }
          { name: 'AZURE_RELEASE_POINTER_BLOB', value: 'current/release-pointer.json' }
          { name: 'AZURE_COLLECTOR_LOCK_BLOB', value: 'locks/collector.lock' }
          { name: 'SIGNING_PUBLIC_KEY_PEM', secretRef: 'signing-public-key' }
        ]
        volumeMounts: [{ volumeName: 'public-share', mountPath: publicSharePath }]
      }]
    }
  }
}

resource dynamicJob 'Microsoft.App/jobs@2024-03-01' = if (enableApps) {
  name: '${namePrefix}-dynamic-collector'
  location: location
  dependsOn: [collectorAcrPull, collectorBlobWrite, collectorVaultSecrets]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${collectorIdentity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 3600
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '*/10 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [{ server: registry.properties.loginServer, identity: collectorIdentity.id }]
      secrets: secretDefinitionsCollector
    }
    template: {
      containers: [{
        name: 'collector'
        image: imageDigest
        command: ['node', '/app/server/src/collector-entrypoint.mjs']
        resources: { cpu: 1, memory: '2Gi' }
        env: concat(sharedCollectorEnv, emergencyMedicalEnv, collectorSecretEnv, [
          { name: 'COLLECTOR_ONESHOT', value: 'true' }
          { name: 'COLLECTOR_INITIAL_SOURCE_IDS', value: 'cwa-earthquake,cwa-weather-warning,cwa-typhoon-warning,ncdr-hazard-events' }
        ])
        volumeMounts: collectorMounts
      }]
      volumes: collectorVolumes
    }
  }
}

resource staticJob 'Microsoft.App/jobs@2024-03-01' = if (enableApps) {
  name: '${namePrefix}-static-collector'
  location: location
  dependsOn: [collectorAcrPull, collectorBlobWrite, collectorVaultSecrets]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${collectorIdentity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 7200
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '0 3 * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [{ server: registry.properties.loginServer, identity: collectorIdentity.id }]
      secrets: secretDefinitionsCollector
    }
    template: {
      containers: [{
        name: 'collector'
        image: imageDigest
        command: ['node', '/app/server/src/collector-entrypoint.mjs']
        resources: { cpu: 1, memory: '4Gi' }
        env: concat(sharedCollectorEnv, emergencyMedicalEnv, collectorSecretEnv, [
          { name: 'COLLECTOR_ONESHOT', value: 'true' }
          { name: 'COLLECTOR_INITIAL_SOURCE_IDS', value: 'taiwan-shelter,taiwan-medical' }
        ])
        volumeMounts: collectorMounts
      }]
      volumes: collectorVolumes
    }
  }
}

resource cleanupJob 'Microsoft.App/jobs@2024-03-01' = if (enableApps) {
  name: '${namePrefix}-release-cleanup'
  location: location
  dependsOn: [cleanupAcrPull, cleanupBlobWrite, cleanupVaultSecrets]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${cleanupIdentity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '30 3 * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [{ server: registry.properties.loginServer, identity: cleanupIdentity.id }]
      secrets: [
        { name: 'signing-public-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/signing-public-key-pem', identity: cleanupIdentity.id }
      ]
    }
    template: {
      containers: [{
        name: 'cleanup'
        image: imageDigest
        command: ['node', '/app/server/src/ops/maintenance-cli.mjs', 'cleanup', '--execute', '--keep-days', '7', '--keep-revisions', '10']
        resources: { cpu: 0.25, memory: '0.5Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'PUBLIC_RELEASE_ROOT', value: publicSharePath }
          { name: 'SIGNING_KEY_ID', value: signingKeyId }
          { name: 'AZURE_CLIENT_ID', value: cleanupIdentity.properties.clientId }
          { name: 'AZURE_STORAGE_BLOB_ENDPOINT', value: storage.properties.primaryEndpoints.blob }
          { name: 'AZURE_CONTROL_CONTAINER', value: controlContainer.name }
          { name: 'AZURE_RELEASE_POINTER_BLOB', value: 'current/release-pointer.json' }
          { name: 'AZURE_COLLECTOR_LOCK_BLOB', value: 'locks/collector.lock' }
          { name: 'SIGNING_PUBLIC_KEY_PEM', secretRef: 'signing-public-key' }
        ]
        volumeMounts: [{ volumeName: 'public-share', mountPath: publicSharePath }]
      }]
      volumes: [{ name: 'public-share', storageType: 'AzureFile', storageName: publicReadWriteMount.name }]
    }
  }
}

resource signingPublicSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = if (enableApps) {
  parent: vault
  name: 'signing-public-key-pem'
}

resource apiAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(registry.id, apiIdentity.id, roleAcrPull)
  scope: registry
  properties: { roleDefinitionId: roleAcrPull, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource apiBlobRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(controlContainer.id, apiIdentity.id, roleBlobReader)
  scope: controlContainer
  properties: { roleDefinitionId: roleBlobReader, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource apiVaultSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(signingPublicSecret.id, apiIdentity.id, roleKeyVaultSecretsUser)
  scope: signingPublicSecret
  properties: { roleDefinitionId: roleKeyVaultSecretsUser, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource collectorAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(registry.id, collectorIdentity.id, roleAcrPull)
  scope: registry
  properties: { roleDefinitionId: roleAcrPull, principalId: collectorIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource collectorBlobWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(controlContainer.id, collectorIdentity.id, roleBlobContributor)
  scope: controlContainer
  properties: { roleDefinitionId: roleBlobContributor, principalId: collectorIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource collectorVaultSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(vault.id, collectorIdentity.id, roleKeyVaultSecretsUser)
  scope: vault
  properties: { roleDefinitionId: roleKeyVaultSecretsUser, principalId: collectorIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource cleanupAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(registry.id, cleanupIdentity.id, roleAcrPull)
  scope: registry
  properties: { roleDefinitionId: roleAcrPull, principalId: cleanupIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource cleanupBlobWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(controlContainer.id, cleanupIdentity.id, roleBlobContributor)
  scope: controlContainer
  properties: { roleDefinitionId: roleBlobContributor, principalId: cleanupIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource cleanupVaultSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableApps) {
  name: guid(signingPublicSecret.id, cleanupIdentity.id, roleKeyVaultSecretsUser)
  scope: signingPublicSecret
  properties: { roleDefinitionId: roleKeyVaultSecretsUser, principalId: cleanupIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource deploymentAcrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deploymentPrincipalObjectId)) {
  name: guid(registry.id, deploymentPrincipalObjectId, roleAcrPush)
  scope: registry
  properties: { roleDefinitionId: roleAcrPush, principalId: deploymentPrincipalObjectId, principalType: 'ServicePrincipal' }
}

resource deploymentVaultSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deploymentPrincipalObjectId)) {
  name: guid(vault.id, deploymentPrincipalObjectId, roleKeyVaultSecretsOfficer)
  scope: vault
  properties: { roleDefinitionId: roleKeyVaultSecretsOfficer, principalId: deploymentPrincipalObjectId, principalType: 'ServicePrincipal' }
}

output acrName string = registry.name
output acrLoginServer string = registry.properties.loginServer
output keyVaultName string = vault.name
output keyVaultUri string = vault.properties.vaultUri
output storageAccountName string = storage.name
output apiUrl string = enableApps ? 'https://${api.properties.configuration.ingress.fqdn}' : ''
