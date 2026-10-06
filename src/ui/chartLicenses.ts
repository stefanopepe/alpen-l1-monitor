import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const echartsRoot = dirname(require.resolve('echarts/package.json'));
const echartsRequire = createRequire(join(echartsRoot, 'package.json'));
const zrenderRoot = dirname(echartsRequire.resolve('zrender/package.json'));
const notices = ['Apache ECharts', ...['LICENSE', 'NOTICE', 'licenses/LICENSE-d3'].map(file => readFileSync(join(echartsRoot, file), 'utf8')),
  'ZRender', readFileSync(join(zrenderRoot, 'LICENSE'), 'utf8')].join('\n\n');

// Include redistribution notices in both hosted and self-contained portable reports.
export const chartLicensesMarkup = '<script type="text/plain" id="chartLicenses">' + notices.replace(/<\/script/gi, '<\\/script') + '</script>';
