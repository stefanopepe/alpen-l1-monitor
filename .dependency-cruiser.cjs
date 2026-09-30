module.exports = {
  forbidden: [
    { name: 'pure-core', severity: 'error', from: { path: '^src/(model/|pipeline/snapshot)' }, to: { pathNot: '^src/(model/|types\\.ts|pipeline/snapshot)' } },
    { name: 'stored-read-only', severity: 'error', from: { path: '^(api/(status|metrics)|src/read/)' }, to: { path: '^src/(chain|discovery|extract|pipeline|config/load|derive|descriptor)' } },
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } }
  ],
  options: { doNotFollow: { path: 'node_modules' }, tsConfig: { fileName: 'tsconfig.json' } }
};
