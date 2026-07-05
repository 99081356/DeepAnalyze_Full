import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModuleCard, MODULE_META } from '../ModuleCard';

// Mock API client
vi.mock('../../../api/client', () => ({
  api: {
    getModule: vi.fn(),
    installModule: vi.fn(),
    uninstallModule: vi.fn(),
    startModule: vi.fn(),
    stopModule: vi.fn(),
    updateModuleConfig: vi.fn(),
    detectGpu: vi.fn(),
  },
}));

import { api } from '../../../api/client';

beforeEach(() => {
  vi.clearAllMocks();
  (api.detectGpu as ReturnType<typeof vi.fn>).mockResolvedValue({
    tier: 'high', hasNvidia: true, vramMB: 24576, deviceName: 'RTX 4090',
  });
  // Stub window.confirm to auto-accept
  window.confirm = vi.fn(() => true);
});

describe('ModuleCard', () => {
  it('renders not_installed state with install button', async () => {
    (api.getModule as ReturnType<typeof vi.fn>).mockResolvedValue({
      module: {
        moduleId: 'embedding', status: 'not_installed', mode: 'disabled',
        gpuRequired: false, processType: 'subprocess', configVersion: 0,
      },
    });
    render(<ModuleCard moduleId="embedding" />);
    await waitFor(() => expect(screen.queryByText(/嵌入模型/)).toBeInTheDocument());
    // Should show local/remote/disabled tabs
    expect(screen.getByText('本地部署')).toBeInTheDocument();
    expect(screen.getByText('远端 API')).toBeInTheDocument();
  });

  it('shows running badge when module is running', async () => {
    (api.getModule as ReturnType<typeof vi.fn>).mockResolvedValue({
      module: {
        moduleId: 'embedding', status: 'running', mode: 'local',
        gpuRequired: true, processType: 'subprocess',
        weightsPath: 'data/models/bge-m3', configVersion: 1,
      },
    });
    render(<ModuleCard moduleId="embedding" />);
    await waitFor(() => expect(screen.getByText('运行中')).toBeInTheDocument());
    expect(screen.getByText(/停止/)).toBeInTheDocument();
  });

  it('calls installModule when install button clicked', async () => {
    (api.getModule as ReturnType<typeof vi.fn>).mockResolvedValue({
      module: {
        moduleId: 'embedding', status: 'not_installed', mode: 'local',
        gpuRequired: false, processType: 'subprocess', configVersion: 0,
      },
    });
    (api.installModule as ReturnType<typeof vi.fn>).mockResolvedValue({
      module: {
        moduleId: 'embedding', status: 'installed', mode: 'local',
        gpuRequired: true, processType: 'subprocess', configVersion: 1,
      },
    });
    render(<ModuleCard moduleId="embedding" />);
    await waitFor(() => expect(screen.getByText('本地部署')).toBeInTheDocument());

    // Find the install button: the one with btn-primary class (not the mode button)
    const localButtons = screen.getAllByRole('button', { name: /本地部署/ });
    const installBtn = localButtons.find((b) => b.classList.contains('btn-primary'));
    expect(installBtn).toBeDefined();
    fireEvent.click(installBtn!);

    await waitFor(() => {
      expect(api.installModule).toHaveBeenCalledWith('embedding', { gpuRequired: true });
    });
  });

  it('MODULE_META has entries for all 4 modules', () => {
    expect(Object.keys(MODULE_META).sort()).toEqual(['asr', 'docling', 'embedding', 'mineru']);
  });

  it('docling card shows VLM backend selector', async () => {
    (api.getModule as ReturnType<typeof vi.fn>).mockResolvedValue({
      module: {
        moduleId: 'docling', status: 'installed', mode: 'local',
        gpuRequired: false, processType: 'subprocess',
        vlmBackend: 'none', configVersion: 0,
      },
    });
    render(<ModuleCard moduleId="docling" />);
    await waitFor(() => expect(screen.getByText('VLM 后端')).toBeInTheDocument());
  });
});
