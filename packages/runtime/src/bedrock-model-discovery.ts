import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type InferenceProfileSummary,
} from '@aws-sdk/client-bedrock';
import type { ModelInfo } from '@maka/core/llm-connections';
import { lookupModelMetadata } from '@maka/core/model-metadata';
import type { AwsCredentialIdentity } from './model-factory.js';
import { ScopedFetchHttpHandler } from './aws-smithy-fetch-handler.js';

const MAX_MODELS = 2_048;
const MAX_PROFILE_PAGES = 64;

/** Account/role/region-authoritative Bedrock Converse catalog. */
export async function discoverBedrockModels(input: {
  readonly region: string;
  readonly credentialProvider: () => PromiseLike<AwsCredentialIdentity>;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<ModelInfo[]> {
  const client = new BedrockClient({
    region: input.region,
    credentials: async () => await input.credentialProvider(),
    requestHandler: new ScopedFetchHttpHandler(input.fetchFn),
  });
  const foundation = await client.send(
    new ListFoundationModelsCommand({ byOutputModality: 'TEXT', byInferenceType: 'ON_DEMAND' }),
    { abortSignal: input.signal },
  );
  const models = new Map<string, ModelInfo>();
  for (const summary of foundation.modelSummaries ?? []) {
    const id = summary.modelId?.trim();
    if (
      !id ||
      summary.modelLifecycle?.status !== 'ACTIVE' ||
      !summary.outputModalities?.includes('TEXT') ||
      !summary.inferenceTypesSupported?.includes('ON_DEMAND')
    ) {
      continue;
    }
    const metadata = lookupModelMetadata('amazon-bedrock', id);
    if (!metadata.capabilities?.functionCalling) continue;
    const displayName = summary.modelName ?? metadata.displayName;
    models.set(id, {
      id,
      ...(displayName ? { displayName } : {}),
      ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow } : {}),
      ...(metadata.maxOutputTokens ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
      capabilities: {
        chat: true,
        ...metadata.capabilities,
        functionCalling: true,
      },
      ...(metadata.modalities ? { modalities: metadata.modalities } : {}),
      bedrock: { kind: 'foundation-model', sourceModelIds: [id] },
    });
  }

  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PROFILE_PAGES; page += 1) {
    const response = await client.send(
      new ListInferenceProfilesCommand({ maxResults: 100, nextToken }),
      { abortSignal: input.signal },
    );
    for (const profile of response.inferenceProfileSummaries ?? []) {
      const projected = profileModel(profile);
      if (projected) models.set(projected.id, projected);
      if (models.size > MAX_MODELS) throw new Error('Amazon Bedrock returned too many models');
    }
    nextToken = response.nextToken;
    if (!nextToken) return [...models.values()];
  }
  throw new Error('Amazon Bedrock inference profile pagination limit exceeded');
}

/** Adds an explicitly probed ID/ARN without inventing vision or reasoning support. */
export function manualBedrockModel(modelId: string): ModelInfo {
  return {
    id: modelId.trim(),
    capabilities: { chat: true, functionCalling: true },
    modalities: { input: ['text'], output: ['text'] },
    bedrock: { kind: 'manual' },
  };
}

function profileModel(profile: InferenceProfileSummary): ModelInfo | undefined {
  const id = profile.inferenceProfileId?.trim();
  if (!id || profile.status !== 'ACTIVE') return undefined;
  const sourceModelIds = Array.from(
    new Set(
      (profile.models ?? [])
        .map((model) => sourceModelId(model.modelArn))
        .filter((source): source is string => Boolean(source)),
    ),
  );
  if (sourceModelIds.length === 0) return undefined;
  const sourceMetadata = sourceModelIds.map((source) =>
    lookupModelMetadata('amazon-bedrock', source),
  );
  if (sourceMetadata.some((metadata) => !metadata.capabilities?.functionCalling)) return undefined;
  const primary = sourceMetadata[0]!;
  return {
    id,
    ...(profile.inferenceProfileName ? { displayName: profile.inferenceProfileName } : {}),
    ...(profile.description ? { description: profile.description } : {}),
    ...(primary.contextWindow ? { contextWindow: primary.contextWindow } : {}),
    ...(primary.maxOutputTokens ? { maxOutputTokens: primary.maxOutputTokens } : {}),
    capabilities: {
      chat: true,
      vision: sourceMetadata.every((metadata) => metadata.capabilities?.vision === true),
      reasoning: sourceMetadata.every((metadata) => metadata.capabilities?.reasoning === true),
      functionCalling: true,
    },
    ...(primary.modalities ? { modalities: primary.modalities } : {}),
    bedrock: { kind: 'inference-profile', sourceModelIds },
  };
}

function sourceModelId(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const marker = ':foundation-model/';
  const index = arn.indexOf(marker);
  return index < 0 ? undefined : arn.slice(index + marker.length).trim() || undefined;
}
