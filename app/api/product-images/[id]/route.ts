import { imagemDoProduto } from "@/lib/services/product-images";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Serve a imagem de um produto por endereço público.
 *
 * Pública porque é isso que ela precisa ser: quem a busca é o servidor do
 * canal de anúncio (a Meta, no caso), que não tem sessão nossa nem deveria
 * ter. O que ela expõe é imagem de produto -- o mesmo que qualquer vitrine
 * mostra.
 *
 * Fora do `proxy.ts` por construção: o matcher de lá já ignora `/api`.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const imagem = await imagemDoProduto(prisma, (await params).id);
  if (!imagem) return new Response("Imagem não encontrada", { status: 404 });
  if (imagem.redirecionar) {
    // Já é endereço público: aponta para ele em vez de copiar os bytes.
    return Response.redirect(imagem.redirecionar, 302);
  }
  return new Response(new Uint8Array(imagem.bytes!), {
    headers: {
      "Content-Type": imagem.tipo!,
      // O conteúdo de um id nunca muda: o álbum cria outra linha ao trocar a
      // imagem. Cache longo poupa o banco de servir o mesmo arquivo a cada
      // revisão de catálogo do provedor.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(imagem.bytes!.length),
    },
  });
}
