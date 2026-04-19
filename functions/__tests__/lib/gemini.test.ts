import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @google/generative-ai
// ---------------------------------------------------------------------------

const mockGetGenerativeModel = vi.fn().mockReturnValue({
  generateContentStream: vi.fn(),
  startChat: vi.fn(),
});

const MockGoogleGenerativeAI = vi.fn().mockImplementation(() => ({
  getGenerativeModel: mockGetGenerativeModel,
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-api-key-123';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('gemini', () => {
  it('getReportModel returns a model with name gemini-2.5-flash', async () => {
    vi.resetModules();
    const { getReportModel } = await import('../../src/lib/gemini');

    const model = getReportModel();

    expect(model).toBeDefined();
    expect(MockGoogleGenerativeAI).toHaveBeenCalledWith('test-api-key-123');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.5-flash' }),
    );
  });

  it('getChatModel returns a model with temperature 0.7 and maxOutputTokens 4096', async () => {
    vi.resetModules();
    const { getChatModel } = await import('../../src/lib/gemini');

    const model = getChatModel();

    expect(model).toBeDefined();
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        generationConfig: expect.objectContaining({
          temperature: 0.7,
          maxOutputTokens: 4096,
        }),
      }),
    );
  });

  it('throws when GEMINI_API_KEY is not set', async () => {
    vi.resetModules();
    process.env.GEMINI_API_KEY = '';

    const { getReportModel } = await import('../../src/lib/gemini');
    expect(() => getReportModel()).toThrow(/GEMINI_API_KEY/);
  });

  it('caches the GoogleGenerativeAI instance (singleton)', async () => {
    vi.resetModules();
    const { getReportModel, getChatModel } = await import('../../src/lib/gemini');

    getReportModel();
    getReportModel();
    getChatModel();

    // GoogleGenerativeAI should only be instantiated once
    expect(MockGoogleGenerativeAI).toHaveBeenCalledTimes(1);
  });

  it('passes the API key from environment to GoogleGenerativeAI', async () => {
    vi.resetModules();
    process.env.GEMINI_API_KEY = 'custom-key-456';
    const { getReportModel } = await import('../../src/lib/gemini');

    getReportModel();

    expect(MockGoogleGenerativeAI).toHaveBeenCalledWith('custom-key-456');
  });
});
