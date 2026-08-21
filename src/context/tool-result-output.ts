import type {ToolResultPart} from "ai";

type ToolResultOutput = ToolResultPart['output']

// textToolResultOutput 很简单，就是把一个字符串包成工具结果的标准格式，返回 { type: 'text', value: 'xxx' }。后面压缩的时
// 候要把旧工具结果替换成 [tool result cleared] 占位符，就得用这个函数来包装。
export function textToolResultOutput(value: string): ToolResultOutput {
    return {type: "text",value}
}

// toolResultOutputToText 是反向操作——把各种类型的工具结果统一转成可读的字符串。为什么要这个？因为后续做 LLM 摘要压缩时，需要把对话
// 历史拼成一段文本喂给模型，模型不认识什么 JSON 对象或多媒体 part，只认识字符串。所以这里针对不同类型做了转换：文本直接拿 value，JSON
// 序列化成字符串，content 类型（可能混着文本和图片）就遍历每个 part，文字提取出来，媒体替换成 [media: 类型] 这样的标记。
export function toolResultOutputToText(output: ToolResultOutput): string{
    switch (output.type){
        case 'text':
        case 'error-text':
            return output.value;
        case 'json':
        case 'error-json':
            return JSON.stringify(output.value);
        case 'content':
            return output.value
                .map(part => part.type === 'text' ? part.text : `[media]: ${(part as any).mediaType}`)
                .join('\n')
    }
    return '1'
}