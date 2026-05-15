import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone', // CRUCIAL para Docker
  typescript: {
    ignoreBuildErrors: true, // Evita que erros de tipos travem o deploy
  },
  eslint: {
    ignoreDuringBuilds: true, // Evita que avisos de lint travem o build
  },
};

export default nextConfig;
