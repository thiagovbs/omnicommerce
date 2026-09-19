import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone', // CRUCIAL para Docker
  experimental: {
    // O padrão de 1 MB recusaria a imagem do produto antes de a validação
    // rodar, com um erro que não diz o que aconteceu. Folga sobre o limite de
    // 3 MB do arquivo, para caber o envelope do multipart.
    serverActions: { bodySizeLimit: '4mb' },
  },
};

export default nextConfig;
