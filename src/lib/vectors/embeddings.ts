export const EMBEDDING_DIM = 384;

interface EmbeddingOutput {
  data: Float32Array;
}

type FeatureExtractionPipeline = (
  input: string | string[],
  options: { pooling: 'mean'; normalize: true },
) => Promise<EmbeddingOutput>;

let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineLoading: Promise<FeatureExtractionPipeline> | null = null;

async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (embeddingPipeline) return embeddingPipeline;
  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = (async () => {
    const { pipeline } = await import('@xenova/transformers');
    console.log('[embeddings] Loading Xenova/all-MiniLM-L6-v2 (first run downloads model)...');
    const startedAt = Date.now();
    const loaded = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    const elapsedMs = Date.now() - startedAt;
    console.log(`[embeddings] Model ready in ${elapsedMs}ms`);
    embeddingPipeline = loaded as FeatureExtractionPipeline;
    return embeddingPipeline;
  })();

  return pipelineLoading;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text || !text.trim()) {
    return new Array(EMBEDDING_DIM).fill(0);
  }

  try {
    const pipe = await getEmbeddingPipeline();
    const truncated = text.slice(0, 512);
    const output = await pipe(truncated, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch (error) {
    console.warn('[embeddings] generateEmbedding failed, using hash fallback', error);
    return hashEmbedding(text);
  }
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  try {
    const pipe = await getEmbeddingPipeline();
    const inputs = texts.map((text) => (text || '').slice(0, 512));
    const results: number[][] = [];

    const batchSize = 32;
    for (let index = 0; index < inputs.length; index += batchSize) {
      const batch = inputs.slice(index, index + batchSize);
      const output = await pipe(batch, { pooling: 'mean', normalize: true });

      for (let offset = 0; offset < batch.length; offset += 1) {
        const start = offset * EMBEDDING_DIM;
        const end = start + EMBEDDING_DIM;
        results.push(Array.from(output.data.slice(start, end)));
      }
    }

    return results;
  } catch (error) {
    console.warn('[embeddings] generateEmbeddings failed, using hash fallback', error);
    return texts.map((text) => hashEmbedding(text || ''));
  }
}

export function hashEmbedding(text: string): number[] {
  const embedding = new Array(EMBEDDING_DIM).fill(0);
  const normalized = text.toLowerCase().trim();
  if (!normalized) return embedding;

  const words = normalized.split(/\s+/).filter((token) => token.length > 1);
  const tokens = [...words];

  for (let index = 0; index < words.length - 1; index += 1) {
    tokens.push(`${words[index]} ${words[index + 1]}`);
  }

  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i += 1) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }

    const idx1 = Math.abs(hash) % EMBEDDING_DIM;
    const idx2 = Math.abs((hash * 31) ^ 0x5f3759df) % EMBEDDING_DIM;
    const idx3 = Math.abs((hash * 97) ^ 0xdeadbeef) % EMBEDDING_DIM;

    embedding[idx1] += 1;
    embedding[idx2] += 0.5;
    embedding[idx3] += 0.25;
  }

  const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return embedding;
  }

  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    embedding[i] /= magnitude;
  }

  return embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimensions differ: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }

  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}
