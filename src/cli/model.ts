/** 本地 Embedding 模型管理命令。 */

import path from 'node:path';
import { getConfiguredEmbeddingModel, getEmbeddingProvider } from '../config.js';
import {
  DEFAULT_LOCAL_MODEL_ID,
  getLocalModelDefinition,
  isLocalModelId,
  LOCAL_MODEL_IDS,
  type LocalModelId,
} from '../models/catalog.js';
import {
  getModelsDir,
  installLocalModel,
  listLocalModelStatuses,
  removeLocalModel,
  useLocalModel,
} from '../models/index.js';
import { logger } from '../utils/logger.js';

export type ModelCommandAction = 'install' | 'list' | 'use' | 'remove';

export async function runModelCommand(
  requestedAction?: string,
  requestedModel?: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const action = resolveAction(requestedAction);
  if (action === 'list') {
    if (requestedModel) throw new Error('model list 不接受模型参数');
    await listModels();
    return;
  }

  const model = resolveModel(action, requestedModel);
  switch (action) {
    case 'install':
      await installModel(model);
      return;
    case 'use':
      await useModel(model);
      return;
    case 'remove':
      await removeModel(model, options.yes === true);
      return;
  }
}

const ACTION_ALIASES: Record<string, ModelCommandAction> = {
  install: 'install',
  list: 'list',
  use: 'use',
  remove: 'remove',
};

function resolveAction(requestedAction?: string): ModelCommandAction {
  const action = ACTION_ALIASES[requestedAction?.trim().toLowerCase() || 'list'];
  if (!action) {
    throw new Error(`未知的 model 操作: ${requestedAction}。可选值: install, list, use, remove`);
  }
  return action;
}

function resolveModel(
  action: Exclude<ModelCommandAction, 'list'>,
  requestedModel?: string,
): LocalModelId {
  if (requestedModel) return getLocalModelDefinition(requestedModel.trim().toLowerCase()).id;
  if (action === 'install') return getConfiguredLocalModel() ?? DEFAULT_LOCAL_MODEL_ID;
  throw new Error(`model ${action} 必须指定模型，可选值: ${LOCAL_MODEL_IDS.join(', ')}`);
}

function getConfiguredLocalModel(): LocalModelId | null {
  if (getEmbeddingProvider() !== 'local') return null;
  const configured = getConfiguredEmbeddingModel();
  if (!configured) return DEFAULT_LOCAL_MODEL_ID;
  return isLocalModelId(configured) ? configured : null;
}

async function listModels(): Promise<void> {
  const statuses = await listLocalModelStatuses();
  logger.info(`本地模型目录: ${getModelsDir()}`);
  for (const status of statuses) {
    const state = [
      status.installed ? '已安装' : status.hasCache ? '缓存不完整' : '未安装',
      status.active ? '当前配置' : '',
    ]
      .filter(Boolean)
      .join('，');
    logger.info(
      `${status.model.id}  ${status.model.parameterSize}  ${status.model.dimensions}维  ${status.model.license}  ${state}`,
    );
  }
}

async function installModel(model: LocalModelId): Promise<void> {
  const definition = getLocalModelDefinition(model);
  logger.info(`开始安装 ${definition.displayName}（${definition.parameterSize}，CPU q8）`);
  let lastFile = '';
  const result = await installLocalModel(model, (progress) => {
    if (progress.status === 'progress_total') return;
    const file = progress.file ? path.basename(progress.file) : '';
    if (progress.status === 'done' && file && file !== lastFile) {
      lastFile = file;
      logger.info(`已下载 ${file}`);
    }
  });
  if (result.alreadyInstalled) {
    logger.info(`${definition.displayName} 已安装，无需重复下载`);
  } else {
    logger.info(`${definition.displayName} 安装完成`);
  }
  logger.info(`启用命令: coderecall model use ${model}`);
}

async function useModel(model: LocalModelId): Promise<void> {
  const envFile = await useLocalModel(model);
  logger.info(`已启用 ${getLocalModelDefinition(model).displayName}`);
  logger.info(`配置已写入 ${envFile}`);
  logger.info('下次索引会在向量空间不兼容时自动重建');
}

async function removeModel(model: LocalModelId, confirmed: boolean): Promise<void> {
  if (!confirmed) {
    throw new Error(`删除模型需要确认: coderecall model remove ${model} --yes`);
  }
  const definition = getLocalModelDefinition(model);
  const status = (await listLocalModelStatuses()).find((item) => item.model.id === model);
  if (!status?.hasCache) {
    logger.info(`${definition.displayName} 无本地缓存，无需删除`);
    return;
  }
  await removeLocalModel(model);
  logger.info(`已删除 ${definition.displayName}`);
  if (status.active) {
    logger.warn(`已删除当前使用的模型。继续使用前请重装: coderecall model install ${model}`);
  }
}
