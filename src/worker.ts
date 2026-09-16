import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, type RenderJob } from './contracts.js';
import { validateSvg } from './policy.js';
import { safeError, AppError } from './errors.js';

process.env.FONTCONFIG_FILE = resolve(fileURLToPath(new URL('../assets/fonts/fonts.conf', import.meta.url)));
const [{ default: sharp }, echarts] = await Promise.all([import('sharp'), import('echarts')]);
sharp.cache(false);
sharp.concurrency(1);
process.on('message', async (job: RenderJob) => {
  let chart: ReturnType<typeof echarts.init> | undefined;
  try {
    const { output } = job;
    chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: output.width, height: output.height });
    chart.setOption(job.option);
    const svg = chart.renderToSVGString();
    validateSvg(svg);
    const width = output.width * output.pixelRatio;
    const height = output.height * output.pixelRatio;
    if (output.format === 'svg') process.send?.({ ok: true, artifact: { mimeType: 'image/svg+xml', width, height, bytes: Buffer.byteLength(svg), svg } });
    else {
      const png = await sharp(Buffer.from(svg), { density: 72 * output.pixelRatio, limitInputPixels: LIMITS.pixels }).resize(width, height).png().toBuffer();
      if (png.length > LIMITS.outputBytes) throw new AppError('OUTPUT_TOO_LARGE', 413, '图像输出超限');
      process.send?.({ ok: true, artifact: { mimeType: 'image/png', width, height, bytes: png.length, base64: png.toString('base64') } });
    }
  } catch (error) { const safe = safeError(error); process.send?.({ ok: false, error: { code: safe.code === 'INTERNAL_ERROR' ? 'RENDER_FAILED' : safe.code, status: safe.status === 500 ? 502 : safe.status, message: safe.code === 'INTERNAL_ERROR' ? '图表渲染失败，请检查 option' : safe.message } }); }
  finally { chart?.dispose(); }
});
process.on('disconnect', () => process.exit(0));
process.send?.({ ready: true });
