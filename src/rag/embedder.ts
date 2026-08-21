import {mock} from "node:test";

export type EmbeddingFn = (text: string[]) => Promise<number[][]>;

export function createMockEmbedder(): EmbeddingFn {
    return async (text: string[]) => text.map(mockEmbed);
}

export function createDashScopeEmbedder(apiKey: string): EmbeddingFn {
    return async (text: string[]) => {
        const resp = await fetch(
            'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({

                    model: 'text-embedding-v3',
                    input: text,
                    dimensions: 128,
                })
            }
        )
        const data = await resp.json() as any;
        return data.data.map((d: any) => d.embedding as number[]);
    }
}

// 创建一个 Map 作为缓存，避免对相同文本重复调用 embedding API，节省成本和时间
const embedCache = new Map<string, number[]>();

// 实现了一个Embedding 缓存层，简单说就是：相同的文本别重复花钱调 API，第一次算完存起来，后面直接用。
export async function embed(fn: EmbeddingFn, texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const uncached: { idx: number; text: string }[] = [];

    // 遍历所有要向量化的文本，每条文本都去 embedCache 里查。命中了直接放到 results 对应位置；没命中就记到 uncached 数组里，
    // 带着它的原始索引 idx。
    for (let i = 0; i < texts.length; i++) {
        const cached = embedCache.get(texts[i]);
        if (cached) {
        results[i] = cached;
        } else {
        uncached.push({ idx: i, text: texts[i] });
        }
    }
    // 如果 uncached 里有东西，就把这些没见过的文本一次性批量发给 embedding 模型。注意这里是批量调用而不是一条一条调，省网络开销。
    // 拿到向量结果后，按 uncached[i].idx 把向量填回 results 的正确位置，同时存进 embedCache。
    if (uncached.length > 0) {
        const vectors = await fn(uncached.map(u => u.text));
        for (let i = 0; i < uncached.length; i++) {
        results[uncached[i].idx] = vectors[i];
        embedCache.set(uncached[i].text, vectors[i]);
        }
    }
    return results;
}

export function cosineSimilarity(a: number[], b: number[]):number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * a[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1) ;
}

const DIMS = 128;
function mockEmbed(text: string): number[] {
  const vec = new Array(DIMS).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % DIMS] += code;
    vec[(i * 7 + 13) % DIMS] += code * 0.3;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}
