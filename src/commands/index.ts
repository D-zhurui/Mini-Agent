import type { ModelMessage } from 'ai';
import type { ToolRegistry } from '../tools/registry.js';
import type { PromptBuilder, PromptContext } from '../context/prompt-builder.js';
import type { UsageTracker } from '../usage/tracker.js';
import type { SessionStore } from '../session/session-store.js';
import type { MemoryStore } from '../memory/store.js';


// 把原来散落在各个模块里的依赖关系集中管理，让命令处理不再需要满世界找变量。
export interface CommandContext {
  messages: ModelMessage[];
  timestamps: Map<number, number>;
  registry: ToolRegistry;
  builder: PromptBuilder;
  tracker: UsageTracker;
  sessionStore: SessionStore;
  model: any;
  makePromptCtx: () => PromptContext;
  ask: () => void;
  memoryStore?: MemoryStore;
  [key: string]: any;
}

// CommandHandler 定义了"处理者"的格式。 它是个函数，接收用户输入的原始命令 cmd 和工具箱 ctx，返回三种状态之一：true 表示"我处理完了，你们别管了"，false 表示"这条不归我管，下一个来"，'async' 表示"我在后台干活，弄完我会自己调用 ctx.ask() 继续对话"。
// 定义识别命令类型的方法的类型
// cmd 是"用户说了什么"，
// ctx 是"处理这件事需要用到的一切资源"。以前这些资源都是通过闭包捕获外层变量的，现在统一塞进 ctx 里，每个命令只从里面取自己需要的那几样。
export type CommandHandler = (cmd: string, ctx: CommandContext) => boolean | 'async';

//createDispatcher 是调度中心。 它就是个责任链模式的实现——把一堆 handler 串成一条链，用户命令来了逐个人问"你认识这条命令吗？"，第一个举手说"我认识"的就接管，后面的不用再问。
export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      const result = h(cmd, ctx);
      if (result) return result;
    }
    return false;
  };
}
