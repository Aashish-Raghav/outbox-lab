/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The shared contract package ships TypeScript sources; Next must compile it
  // rather than expecting a prebuilt CommonJS bundle.
  transpilePackages: ['@reachinbox/shared'],

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
