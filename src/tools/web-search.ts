import type {ToolDefinition} from "./registry";
import TurndownService from 'turndown';

/*创建一个 Turndown 实例，设置用 ## 这种 ATX 风格标题和围栏代码块
过滤掉 <script>、<style> 这些网页“脏东西”，只保留正文
把 HTML 转成 Markdown 返回*/
function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  // 过滤掉导航、页脚这些噪音内容
  turndown.remove(['script', 'style', 'nav', 'footer']);

  return turndown.turndown(html);
}

// ----------Tavily--------------------
export const tavilySearchTool: ToolDefinition = {
    name: 'web_search',
    description: '搜索互联网获取最新信息，返回相关网页的标题、链接和内容摘要',
    parameters: {
        type:'object',
        properties:{
            query: {type: 'string', description: '搜索关键词'},
            max_results: {type: 'number', description: '返回结果数量，默认5'}
        },
        required:['query'],
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async({query, max_result = 5}: {query:string; max_result?: number}) => {
        const apiKey = process.env.TAVILY_API_KEY;
        if (!apiKey) return '[web_search] 未配置 TAVILY_API_KEY, 请在 .env 中配置';

        // 你告诉它"帮我搜一下 XXX"，它就去 Tavily 的服务器上查，返回给你整理好的网页标题、链接和内容摘要。
        const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                api_key: apiKey,
                query,
                max_result,
                include_answer: true,
            }),
        });
        if (!res.ok) return `[web_search] 请求失败: Http ${res.status}`;


        /* res 是 fetch 返回的 Response 对象，它的 json() 方法会把 HTTP 响应的 body（一段 JSON 格式的字符串）
        解析成 JS 对象。比如服务器返回的是 {"answer":"hello"}，经过 res.json() 就变成了 {answer: "hello"}，你可
        以直接用 data.answer 来取值。*/
        // 后面那个 as any 是 TypeScript 的类型断言，意思是"这个变量我不做类型检查，当它什么类型都行"。
        const data = await res.json() as any;
        const lines: string[] = [];

        if (data.answer){
            lines.push(`## AI 摘要\n ${data.answer} \n`);
        }

        for (const r of data.result || []) {
            lines.push(`### ${r.title}`);
            lines.push(r.url);
            lines.push(r.content || r.snippet || '');
            lines.push('');
        }

        return lines.join('\n') || '没有找到相关结果';
    }
}

export const serperSearchTool: ToolDefinition = {
    name: 'web_search',
    description: '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
    parameters:{
        type: 'object',
        properties:{
            query: { type: 'string', description: '搜索关键词' },
            max_results: { type: 'number', description: '返回结果数量，默认 5' },
        },
        required:['query'],
    },
    isConcurrencySafe:true,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async({query, max_results = 5}: {query:string; max_results?: number})=>{
        const apiKey = process.env.SERPER_API_KEY;
        if (!apiKey) return '[web_search] 未配置 SERPER_API_KEY，请在 .env 中设置';
        // Serper 把参数塞在请求头和 URL 里，用的是传统 Google 风格的 q 和 num；Tavily 则把所有参数（包括 API Key）都 JSON 化放在请求体里，更"现代"。
        const res = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'X-API-KEY': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ q: query, num: max_results }),
        });

        if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;
        const data = await res.json() as any;
        const lines: string[] = [];

        if (data.knowledgeGraph){
            const kg = data.knowledgeGraph;
            lines.push(`## ${kg.title}`);
            if (kg.description) lines.push(kg.description);
            lines.push('');
        }

        /* Tavily：请求体里直接 max_results，API 严格按这个数返回，data.results 的 length 就已经是你想要的了。
        Serper：请求体用的参数名叫 num，而且 Google 的搜索 API 传统上不保证精确控制，所以返回后得
        自己再 .slice(0, max_results) 一下，确保不会因为各种边缘情况多出几条。 */

        for (const r of (data.organic || []).slice(0, max_results)) {
            lines.push(`### ${r.title}`);
            lines.push(r.link);
            lines.push(r.snippet || '');
            lines.push('');
        }
        return lines.join('\n') || '没有找到相关结果';
    }
}

// web_fetch 就是 fetch_url 的升级版，最大的区别在于它给 LLM 喂的不是纯文本，而是保留了结构的 Markdown。
// LLM 读 Markdown 就像你读这篇文章一样，一眼就能看出层次结构，信息密度高得多。
export const webFetchTool: ToolDefinition=  {
    name: 'web_fetch',
    description: '抓取指定URL的网页内容,转换未Markdown格式',
    parameters: {
        type: 'object',
        properties: {
            url: {type: 'string', description:'完整 URL'},
        },
        required: ['url'],
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async({url}:{url:string})=>{
        try {
            const res = await fetch(url, {
                headers: {'User-Agent': 'Mozilla/5.0 (compatible; SuperAgent/1.0)'},
                signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) return `抓取失败: HTTP ${res.status}`;
            const html = await res.text();
            return htmlToMarkdown(html);
        } catch (err: any) {
            return `抓取失败: ${err.message}`;
        }
    }
}

export function pickSearchTool(): ToolDefinition {
    if (process.env.TAVILY_API_KEY) return tavilySearchTool;
    if (process.env.SERPER_API_KEY) return serperSearchTool;
    return tavilySearchTool;
}