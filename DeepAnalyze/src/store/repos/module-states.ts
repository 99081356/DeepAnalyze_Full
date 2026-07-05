import pg from 'pg';

export const MODULE_IDS = ['embedding', 'asr', 'docling', 'mineru'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export type ModuleStatus = 'not_installed' | 'installing' | 'installed' | 'running' | 'error';
export type ModuleMode = 'local' | 'remote' | 'disabled';
export type ProcessType = 'subprocess' | 'docker';
export type RemoteProtocol = 'openai' | 'mineru-rest' | 'docling-rest';
export type DoclingVlmBackend = 'none' | 'paddleocr-vl-local' | 'glm-ocr-local' | 'remote-openai-vlm';

export interface ModuleState {
  moduleId: ModuleId;
  status: ModuleStatus;
  mode: ModuleMode;
  weightsPath?: string | null;
  weightsSizeMb?: number | null;
  gpuRequired: boolean;
  processType: ProcessType;
  remoteEndpoint?: string | null;
  remoteApiKey?: string | null;
  remoteProtocol?: RemoteProtocol | null;
  vlmBackend?: DoclingVlmBackend | null;
  lastError?: string | null;
  installedAt?: Date | null;
  startedAt?: Date | null;
  configVersion: number;
}

export class PgModuleStatesRepo {
  constructor(private pool: pg.Pool) {}

  async get(moduleId: ModuleId): Promise<ModuleState | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM module_states WHERE module_id = $1',
      [moduleId],
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async list(): Promise<ModuleState[]> {
    const { rows } = await this.pool.query('SELECT * FROM module_states ORDER BY module_id');
    return rows.map((r) => this.mapRow(r));
  }

  async upsert(state: Partial<ModuleState> & { moduleId: ModuleId }): Promise<ModuleState> {
    const {
      moduleId,
      status,
      mode,
      weightsPath,
      weightsSizeMb,
      gpuRequired = false,
      processType = 'subprocess',
      remoteEndpoint,
      remoteApiKey,
      remoteProtocol,
      vlmBackend,
      lastError,
      installedAt,
      startedAt,
      configVersion = 0,
    } = state;
    const statusVal = status ?? null;
    const modeVal = mode ?? null;
    const { rows } = await this.pool.query(
      `INSERT INTO module_states (
        module_id, status, mode, weights_path, weights_size_mb, gpu_required,
        process_type, remote_endpoint, remote_api_key, remote_protocol,
        vlm_backend, last_error, installed_at, started_at, config_version
      ) VALUES (
        $1, COALESCE($2, 'not_installed'), COALESCE($3, 'disabled'), $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14, $15
      )
      ON CONFLICT (module_id) DO UPDATE SET
        status = COALESCE($2, module_states.status),
        mode = COALESCE($3, module_states.mode),
        weights_path = COALESCE($4, module_states.weights_path),
        weights_size_mb = COALESCE($5, module_states.weights_size_mb),
        gpu_required = COALESCE($6, module_states.gpu_required),
        process_type = COALESCE($7, module_states.process_type),
        remote_endpoint = COALESCE($8, module_states.remote_endpoint),
        remote_api_key = COALESCE($9, module_states.remote_api_key),
        remote_protocol = COALESCE($10, module_states.remote_protocol),
        vlm_backend = COALESCE($11, module_states.vlm_backend),
        last_error = $12,
        installed_at = COALESCE($13, module_states.installed_at),
        started_at = COALESCE($14, module_states.started_at),
        config_version = COALESCE($15, module_states.config_version)
      RETURNING *`,
      [
        moduleId, statusVal, modeVal, weightsPath ?? null, weightsSizeMb ?? null,
        gpuRequired, processType, remoteEndpoint ?? null, remoteApiKey ?? null,
        remoteProtocol ?? null, vlmBackend ?? null, lastError ?? null,
        installedAt ?? null, startedAt ?? null, configVersion,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async delete(moduleId: ModuleId): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM module_states WHERE module_id = $1',
      [moduleId],
    );
    return (rowCount ?? 0) > 0;
  }

  private mapRow(r: any): ModuleState {
    return {
      moduleId: r.module_id,
      status: r.status,
      mode: r.mode,
      weightsPath: r.weights_path,
      weightsSizeMb: r.weights_size_mb,
      gpuRequired: r.gpu_required,
      processType: r.process_type,
      remoteEndpoint: r.remote_endpoint,
      remoteApiKey: r.remote_api_key,
      remoteProtocol: r.remote_protocol,
      vlmBackend: r.vlm_backend,
      lastError: r.last_error,
      installedAt: r.installed_at,
      startedAt: r.started_at,
      configVersion: r.config_version,
    };
  }
}
