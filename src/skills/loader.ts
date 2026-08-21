import fs from 'node:fs';
import path from 'node:path';

export interface SkillDefinition {
    name: string;
    description: string;
    whenToUse?: string;
    content: string;
    dirPath: string;
}

const SKILLS_DIR = '.skills';
const SKILL_FILE = 'SKILL.md';

export class SkillLoader {
    private readonly baseDir: string;
    private skills = new Map<string, SkillDefinition>();

    constructor(baseDir = '.') {
        this.baseDir = baseDir;
    }

    private get skillsDir(): string {
        return path.join(this.baseDir, SKILLS_DIR);
    }

    // 扫描 .skills 下一级目录。
    //
    // 读取每个子文件夹内的 SKILL.md，提取元数据和正文。
    //
    // 存入内存 Map（this.skills）。
    load(): SkillDefinition[] {
        this.skills.clear();
        if (!fs.existsSync(this.skillsDir)) return [];

        const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(this.skillsDir, entry.name, SKILL_FILE);
            if (!fs.existsSync(skillFile)) continue;

            const raw = fs.readFileSync(skillFile, 'utf-8');
            const parsed = this.parseFrontmatter(raw);
            if (!parsed) continue;

            const skill: SkillDefinition = {
                name: entry.name,
                description: parsed.description,
                whenToUse: parsed.whenToUse,
                content: parsed.content,
                dirPath: path.join(this.skillsDir, entry.name),
            };
            this.skills.set(skill.name, skill);
        }

        return this.list();
    }

    list(): SkillDefinition[] {
        return Array.from(this.skills.values());
    }

    get(name: string): SkillDefinition | undefined {
        return this.skills.get(name);
    }

    // 构建提示词片段 (buildPromptSection)
    buildPromptSection(activeSkills: Set<string>): string | null {
        if (this.skills.size === 0) return null;

        const lines: string[] = [];

        if (activeSkills.size > 0) {
            for (const name of activeSkills) {
                const skill = this.skills.get(name);
                if (!skill) continue;
                lines.push(`[激活的 Skill: ${skill.name}]`);
                lines.push(skill.content);
                lines.push('');
            }
        }

        const available = this.list()
            .filter(s => !activeSkills.has(s.name))
            .map(s => {
                const hint = s.whenToUse ? ` (适用场景: ${s.whenToUse})` : '';
                return `  /${s.name} — ${s.description}${hint}`;
            });

        if (available.length > 0) {
            lines.push('可用的 Skills（输入 /skill load <name> 激活）：');
            lines.push(...available);
        }

        return lines.length > 0 ? lines.join('\n') : null;
    }

    // 这段代码就是一个"贴标签拆包裹"的小工具——把 SKILL.md 文件拆成两部分：开头的 --- 包裹的元信息（描述、适用场景之类），和后面的正文内容。
    private parseFrontmatter(raw: string): { description: string; whenToUse?: string; content: string } | null {
        const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!match) return { description: '', content: raw };

        const meta: Record<string, string> = {};
        for (const line of match[1].split('\n')) {
            const idx = line.indexOf(':');
            if (idx > 0) {
                const key = line.slice(0, idx).trim();
                let value = line.slice(idx + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                meta[key] = value;
            }
        }

        return {
            description: meta.description || '',
            whenToUse: meta.when_to_use || undefined,
            content: match[2].trim(),
        };
    }
}
