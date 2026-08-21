export type Role = 'owner' | 'collaborator' | 'guest';

export interface UserIdentity {
    id: string;
    name: string;
    role: Role;
}

const TOOL_ACCESS: Record<Role, {allow: string[] | '*'; deny: string[]}> = {
    owner:{
        allow: '*',
        deny: [],
    },
    collaborator:{
        allow: '*',
        deny: ['bash'],
    },
    guest: {
        allow: ['get_weather', 'calculator', 'read_file', 'list_directory', 'glob', 'grep', 'rag_search'],
        deny: [],
    }
};

// 权限判断逻辑
export function canUseTool(role: Role, toolName: string): boolean{
    const access = TOOL_ACCESS[role];
    if(access.deny.includes(toolName)){return false;}
    if(access.allow === '*'){return true;}
    return access.allow.includes(toolName);
}

// 这个函数是 canUseTool 的批处理版本。当你需要将一个完整的工具列表（例如，注册表中的所有工具）提供给用户时，这个函数会遍历所有工具名，
// 过滤掉那些用户无权调用的工具，只返回一个“安全”的工具子集。
export function filterToolsForRole(toolNames: string[], role: Role): string[] {
    return toolNames.filter(name => canUseTool(role, name));
}