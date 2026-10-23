export default {
  test: {
    include: ['infra/security/tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10000,
  },
};
