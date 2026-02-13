// 命令相关类型定义

export interface Command {
  id: string;
  name: string;
  data: string;
  description?: string;
  createdAt: number;
}

export interface CommandGroup {
  id: string;
  name: string;
  commands: Command[];
  createdAt: number;
  updatedAt: number;
}

// 创建新命令的默认值
export const createEmptyCommand = (): Omit<Command, 'id' | 'createdAt'> => ({
  name: '',
  data: '',
  description: '',
});

// 创建新命令组的默认值
export const createEmptyCommandGroup = (): Omit<CommandGroup, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  commands: [],
});
