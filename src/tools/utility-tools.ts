import {ToolDefinition} from "./registry";
import {join, resolve, extname, relative} from 'node:path'
import {createServer, type Server} from 'node:http'
import {readFileSync, existsSync} from 'node:fs'


export const weatherTool: ToolDefinition = {
    name: 'get_weather',
    description: '查询指定城市的天气信息',
    parameters:{
        type: 'object',
        properties:{
            city: {type: 'string', description:'城市名称，如“北京”，“上海”'},
        },
        required:['city'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({city}:{city:string})=> {
        const data: Record<string, string> = {
            '北京': '晴，15-25°C，东南风 2 级',
            '上海': '多云，18-22°C，西南风 3 级',
            '深圳': '阵雨，22-28°C，南风 2 级',
        };
        return data[city] || `${city}：暂无数据`;
    }
}

export const calculatorTool: ToolDefinition = {
    name:'get_calculator',
    description:'计算数学表达式的结果，当用户提问涉及数学运算时使用',
    parameters:{
        type: 'object',
        properties: {
            expression: {type:'string', description:'数学表达式，如2 + 3 * 4'}
        },
        required: ['expression'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async({expression}:{expression:string})=>{
        try {
            // new Function 是JavaScript里动态创建函数的方法，  （）——立刻调用这个刚创建的函数
            const result = new Function(`return ${expression}`)();
            return `${expression} = ${result}`
        }catch{
            return`无法计算: ${expression}`;
        }

    }
}

const MOCK_PAGES: Record<string, string> = {
  'https://esm.sh': `esm.sh - 一个免费的 ES module CDN。直接 import "https://esm.sh/react@18" 就能用最新版 React，自动处理依赖打包、TypeScript 支持和 JSX 转换，配合浏览器 import maps 可以零构建运行 React 项目。`,

  'https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling': `AI SDK Core - Tools and Tool Calling
工具是模型可以决定调用的函数。一个工具由三部分组成：
- description：告诉模型何时使用这个工具
- inputSchema：通过 Zod 或 JSON Schema 定义参数
- execute：实际在服务端运行的函数

通过 stopWhen: stepCountIs(N) 实现多步工具执行。
当模型在一个 step 中发出多个 tool-call 时，工具会默认并行执行。`,

  'https://ai-sdk.dev/docs/ai-sdk-core/generating-text': `AI SDK Core - Generating Text
streamText() 返回流式响应，包含文本和工具调用的增量更新。
通过 fullStream 可以拿到所有事件类型：text-delta、tool-call、tool-result、finish。
generateText() 是非流式版本，最终返回完整结果。`,
};

export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description: '抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,    // 只读、可并发——抓多个 URL 时直接并行
  isReadOnly: true,
  maxResultChars: 1500,        // 网页通常很长，截断兜底
  execute: async ({ url }: { url: string }) => {
    // Object.keys()把一个对象的所有"钥匙"（属性名）掏出来，装进一个数组。
    for (const key of Object.keys(MOCK_PAGES)) {
        // url.startsWith()做前缀匹配，看用户真正想抓的网址是不是命中了某个预置的假数据页面。
      if (url.startsWith(key)) return MOCK_PAGES[key];
    }
    try {
        // fetch() 就是 Node.js 内置的发 HTTP 请求的函数， 把目标网页的原始数据拿回来
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 SuperAgent' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return `请求失败：HTTP ${res.status}`;
      const html = await res.text();
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '页面无文本内容';
    } catch (err: any) {
      return `抓取失败：${err.message}`;
    }
  },
};

let previewServer: Server | null = null;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description: '启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具',
  parameters: {
    type: 'object',
    properties: { port: { type: 'number' } },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`;
    const root = resolve('app');
    if (!existsSync(root)) return '错误：app/ 目录不存在';

    previewServer = createServer((req, res) => {
      const urlPath = (req.url?.split('?')[0] || '/').replace(/\/$/, '/index.html');
      const filePath = join(root, urlPath === '/' ? '/index.html' : urlPath);
      try {
        if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(readFileSync(filePath));
      } catch { res.writeHead(404); res.end('Not Found'); }
    });

    return new Promise<string>((resolve) => {
      previewServer!.listen(port, () => {
        resolve(`✓ 预览服务器已启动 → http://localhost:${port}`);
      });
    });
  },
};
