/**
 * 本地 Embedding 模型的安装、启用和删除。
 *
 * 推理始终离线加载。只有 install 会联网下载。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getConfiguredEmbeddingModel, getEmbeddingProvider } from '../config.js';
import { getDataBaseDir, resolveEnvFilePath } from '../utils/paths.js';
import {
  DEFAULT_LOCAL_MODEL_ID,
  getLocalModelDefinition,
  isLocalModelId,
  type LocalModelDefinition,
  type LocalModelId,
  listLocalModels,
} from './catalog.js';

const MODEL_INSTALL_MARKER = 'install.json';

export interface ModelProgress {
  status: string;
  file?: string;
  progress?: number;
}

export interface ModelInstallMarker {
  version: 1;
  model: LocalModelId;
  repo: string;
  revision: string;
  dtype: string;
  dimensions: number;
}

export interface LocalModelStatus {
  model: LocalModelDefinition;
  installed: boolean;
  hasCache: boolean;
  active: boolean;
}

export function getModelsDir(): string {
  return path.join(getDataBaseDir(), 'models');
}

export function getLocalModelDir(model: string): string {
  const definition = getLocalModelDefinition(model);
  return path.join(getModelsDir(), definition.id);
}

export function getInstallMarkerPath(model: string): string {
  return path.join(getLocalModelDir(model), MODEL_INSTALL_MARKER);
}

/** 只读安装标记，不加载模型，也不访问网络。 */
export async function readModelInstallMarker(model: string): Promise<ModelInstallMarker | null> {
  const definition = getLocalModelDefinition(model);
  try {
    const [stats, content] = await Promise.all([
      fs.stat(getLocalModelDir(definition.id)),
      fs.readFile(getInstallMarkerPath(definition.id), 'utf8'),
    ]);
    if (!stats.isDirectory()) return null;
    const marker = JSON.parse(content) as Partial<ModelInstallMarker>;
    if (
      marker.version !== 1 ||
      marker.model !== definition.id ||
      marker.repo !== definition.repo ||
      marker.revision !== definition.revision ||
      marker.dtype !== definition.dtype ||
      marker.dimensions !== definition.dimensions
    ) {
      return null;
    }
    return marker as ModelInstallMarker;
  } catch {
    return null;
  }
}

export async function isLocalModelInstalled(model: string): Promise<boolean> {
  return (await readModelInstallMarker(model)) !== null;
}

async function hasLocalModelCache(model: LocalModelId): Promise<boolean> {
  try {
    return (await fs.stat(getLocalModelDir(model))).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function listLocalModelStatuses(): Promise<LocalModelStatus[]> {
  const active = getActiveLocalModelId();
  return Promise.all(
    listLocalModels().map(async (model) => ({
      model,
      installed: await isLocalModelInstalled(model.id),
      hasCache: await hasLocalModelCache(model.id),
      active: active === model.id,
    })),
  );
}

/**
 * 显式安装模型。只有这条路径允许 Transformers.js 访问网络。
 * 安装标记在完整加载成功后才原子写入。
 */
export async function installLocalModel(
  model: string,
  onProgress?: (progress: ModelProgress) => void,
): Promise<{ model: LocalModelDefinition; alreadyInstalled: boolean }> {
  const definition = getLocalModelDefinition(model);
  if (await isLocalModelInstalled(definition.id)) {
    return { model: definition, alreadyInstalled: true };
  }

  const modelDir = getLocalModelDir(definition.id);
  await fs.mkdir(modelDir, { recursive: true });

  try {
    const { loadLocalModel } = await import('../api/localEmbedding.js');
    const loaded = await loadLocalModel(definition, {
      localFilesOnly: false,
      onProgress,
    });
    await loaded.dispose();

    await writeInstallMarker({
      version: 1,
      model: definition.id,
      repo: definition.repo,
      revision: definition.revision,
      dtype: definition.dtype,
      dimensions: definition.dimensions,
    });
    return { model: definition, alreadyInstalled: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`本地模型安装失败（${definition.id}）：${message}`);
  }
}

export async function useLocalModel(model: string): Promise<string> {
  const definition = getLocalModelDefinition(model);
  if (!(await isLocalModelInstalled(definition.id))) {
    throw new Error(
      `本地模型 ${definition.id} 尚未安装，请先运行: coderecall model install ${definition.id}`,
    );
  }

  const envFile = resolveEnvFilePath();
  let content = '';
  try {
    content = await fs.readFile(envFile, 'utf8');
  } catch (error) {
    const code = error as { code?: string };
    if (code.code !== 'ENOENT') throw error;
  }

  const next = updateEnvContent(content, {
    EMBEDDINGS_PROVIDER: 'local',
    EMBEDDINGS_MODEL: definition.id,
    EMBEDDINGS_DIMENSIONS: String(definition.dimensions),
  });
  if (next !== content) {
    await fs.mkdir(path.dirname(envFile), { recursive: true });
    await atomicWrite(envFile, next);
  }
  return envFile;
}

export async function removeLocalModel(model: string): Promise<void> {
  const definition = getLocalModelDefinition(model);
  await fs.rm(getLocalModelDir(definition.id), { recursive: true, force: true });
}

/** 按行更新 .env，保留注释和未涉及的配置。 */
export function updateEnvContent(content: string, updates: Record<string, string>): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(
      `^(\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*)(.*?)(\\s+#.*)?$`,
    );
    let matched = false;
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(pattern);
      if (!match) continue;
      lines[index] = `${match[1]}${value}${match[3] ?? ''}`;
      matched = true;
    }
    if (!matched) lines.push(`${key}=${value}`);
  }

  return `${lines.join(newline)}${newline}`;
}

function getActiveLocalModelId(): LocalModelId | null {
  if (getEmbeddingProvider() !== 'local') return null;
  const model = getConfiguredEmbeddingModel();
  if (!model) return DEFAULT_LOCAL_MODEL_ID;
  return isLocalModelId(model) ? model : null;
}

async function writeInstallMarker(marker: ModelInstallMarker): Promise<void> {
  const markerPath = getInstallMarkerPath(marker.model);
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, markerPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let mode = 0o600;
  try {
    mode = (await fs.stat(filePath)).mode & 0o777;
  } catch {
    // 新配置文件只允许 owner 读写。
  }

  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(
      `更新 ${filePath} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
