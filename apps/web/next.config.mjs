/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile the shared workspace package (it ships raw TS).
  transpilePackages: ['@turtle/shared'],
  webpack: (config) => {
    // @turtle/shared is ESM TypeScript that imports siblings with explicit `.js`
    // specifiers (e.g. `export * from './messages.js'`). Teach webpack to resolve
    // those `.js` specifiers to the real `.ts`/`.tsx` sources so runtime (non-type)
    // imports from the package resolve during the build.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
