export interface Chunk {
    id: string;
    text: string;
    source: string;     //文件来源
    index: number;      //在文档中的位置
    tokenEstimate: number;
}

const TARGET_TOKENS = 256;
const CHARS_PER_TOKENS = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKENS;;

export function chunkDocument(source: string, text: string): Chunk[] {
    const paragraphs = text.split('\n{2,}');
    const chunks: Chunk[] = [];
    let current = '';
    let idx = 0;

    for(const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        /* 这里是关键判断：如果当前缓冲区已有的内容 + 即将加入的新段落超过了目标大小（1024 字符），就先把缓冲区的存起来**。+ 2 是因为
       后面会用 \n\n 连接段落，这个分隔符也占两个字符。current.length > 0 确保缓冲区非空才存，避免存个空壳。
       把缓冲区变成一个正式的 Chunk 对象（包含 id、source、index 等元数据），然后清空缓冲区，准备装下一组段落。*/
        if (current.length + trimmed.length + 2 > TARGET_CHARS && current.length > 0) {
            chunks.push(makeChunk(source, current.trim(), idx++));
            current = '';
        }
        // 单个段落就超过了目标大小（比如一大段没有空行的代码注释或连续文本）。这时候不能再按段落边界切了，得按句子切
        if(trimmed.length > TARGET_CHARS) {
            if (current.length > 0) {
                chunks.push(makeChunk(source, current.trim(), idx++));
                current = '';
            }
            const sentences = text.split(/(?<=[。！？.!?])\s*/);
            let sentBuf = '';
            for (const sent of sentences) {
                if (sentBuf.length + sent.length + 1 > TARGET_CHARS && sentBuf.length > 0) {
                    chunks.push(makeChunk(source, current.trim(), idx++));
                    sentBuf = '';
                }
                sentBuf += (sentBuf ? ' ' : '') + sent;
            }
            if (sentBuf.trim()){
                current = sentBuf.trim();
            }
        }else{
            // 新段落加到缓冲区末尾。current ? '\n\n' : '' 处理的是第一个段落前不要加分隔符，后面的段落之间用 \n\n 连接。
           current += (current ? '\n\n' : '') + trimmed;
        }
    }

    // 循环结束后，缓冲池中可能还存在剩余的段落，再次push进去
    if (current.trim()) {
        chunks.push(makeChunk(source, current.trim(), idx++));
    }
    return chunks;
}

// 创建chunk的函数
function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    id: `${source}#${index}`,
    text,
    source,
    index,
    tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKENS),
  };
}