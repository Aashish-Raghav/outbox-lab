/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The shared contract package ships TypeScript sources; Next must compile it
  // rather than expecting a prebuilt CommonJS bundle.
  transpilePackages: ['@reachinbox/shared'],

  /**
   * The shared package is authored for Node's ESM resolver, so its internal
   * imports carry explicit `.js` extensions (`./constants.js`). TypeScript maps
   * those back to `.ts` on disk; webpack does not, and fails with
   * "Can't resolve './constants.js'".
   *
   * `extensionAlias` teaches it the same mapping, which lets the dashboard
   * consume the contract straight from source — no build step between editing a
   * zod schema and seeing the type error in the UI.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },

  /**
   * Proxies the API through the Next origin in development.
   *
   * The session is an httpOnly cookie. Same-origin requests carry it without
   * any SameSite=None / secure-cookie gymnastics, which would otherwise be
   * required to talk to localhost:4000 from localhost:3000 and would not
   * reflect how this is deployed.
   */
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_ORIGIN ?? 'http://localhost:4000'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
