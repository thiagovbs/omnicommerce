import { MarketplaceProvider } from "@prisma/client";
import { objectInput, OrderError } from "./order-input";

/**
 * O que cada provedor exige para ser configurado, em um só lugar.
 *
 * Este catálogo é a fonte da tela E da validação. Se fosse só da tela, o
 * servidor aceitaria campo que o formulário não mostra; se fosse só do
 * servidor, a tela pediria campo que ninguém usa. Os dois leem daqui.
 *
 * O que NÃO entra aqui, de propósito:
 *
 * - **Token da conta** (access/refresh). Ele é por conta autorizada, não por
 *   canal, e já mora em `MarketplaceConnection` cifrado. Duplicar aqui criaria
 *   duas verdades sobre a mesma credencial.
 * - **`APP_URL`**. É o endereço público DESTE deploy, usado para montar o
 *   `redirect_uri`. É da instalação, não da organização: continua no ambiente.
 * - **Chave de cifra** (`INTEGRATION_ENCRYPTION_KEY`). É o cofre onde estes
 *   valores são guardados; guardá-la aqui seria trancar a chave dentro do
 *   cofre.
 */

export type TipoDeCampo = "texto" | "url" | "segredo" | "booleano" | "numero";

export interface CampoDeConfig {
  chave: string;
  rotulo: string;
  tipo: TipoDeCampo;
  obrigatorio: boolean;
  /// Texto da tela. Diz o que acontece sem o campo, não só o que ele é.
  ajuda: string;
  /// Valor sugerido quando em branco. Some da tela como placeholder.
  padrao?: string;
  /// Só para o segredo que a plataforma precisa ENCONTRAR pelo valor: o da URL
  /// de webhook, que o provedor chama sem dizer de quem é o aviso.
  buscavel?: boolean;
}

/// Comprimento mínimo do segredo de webhook. É o mesmo piso que
/// `handleProviderNotification` exige para aceitar um aviso: um segredo curto
/// é adivinhável, e o endpoint responde 404 para quem erra.
export const MINIMO_SEGREDO_WEBHOOK = 32;

const CAMPO_WEBHOOK: CampoDeConfig = {
  chave: "webhookSecret",
  rotulo: "Segredo do webhook",
  tipo: "segredo",
  obrigatorio: false,
  buscavel: true,
  ajuda:
    `Compõe a URL de aviso que você cadastra no provedor. Mínimo de ${MINIMO_SEGREDO_WEBHOOK}` +
    " caracteres. Sem ele, todo aviso é recusado com 404 e os pedidos só entram" +
    " pela conciliação periódica.",
};

const CAMPOS: Record<MarketplaceProvider, CampoDeConfig[]> = {
  MERCADO_LIVRE: [
    {
      chave: "appId", rotulo: "App ID", tipo: "texto", obrigatorio: true,
      ajuda: "Identificador da SUA aplicação no Devcenter do Mercado Livre."
        + " Também é conferido no aviso: notificação de outra aplicação é ignorada.",
    },
    {
      chave: "appSecret", rotulo: "App Secret", tipo: "segredo", obrigatorio: true,
      ajuda: "Chave secreta da aplicação. Usada para trocar o código por token e"
        + " para renovar. Guardada cifrada e nunca devolvida para a tela.",
    },
    CAMPO_WEBHOOK,
    {
      chave: "scope", rotulo: "Escopo do OAuth", tipo: "texto", obrigatorio: false,
      padrao: "offline_access read write",
      ajuda: "Sem `offline_access` a autorização morre em 6 horas e não há como"
        + " renovar sem a pessoa autorizar de novo.",
    },
    {
      chave: "authUrl", rotulo: "URL de autorização", tipo: "url", obrigatorio: false,
      padrao: "https://auth.mercadolivre.com.br",
      ajuda: "Troque só para atender outro país. Aceita apenas domínio do Mercado Livre.",
    },
    {
      chave: "tokenUrl", rotulo: "URL de token", tipo: "url", obrigatorio: false,
      padrao: "https://api.mercadolibre.com",
      ajuda: "Idem. Aceita apenas domínio do Mercado Livre.",
    },
  ],

  SHOPEE: [
    {
      chave: "partnerId", rotulo: "Partner ID", tipo: "numero", obrigatorio: true,
      ajuda: "Identificador da sua aplicação na Open Platform. Entra na"
        + " assinatura de cada chamada.",
    },
    {
      chave: "partnerKey", rotulo: "Partner Key", tipo: "segredo", obrigatorio: true,
      ajuda: "Chave da assinatura HMAC-SHA256. Guardada cifrada.",
    },
    {
      chave: "sandbox", rotulo: "Usar sandbox", tipo: "booleano", obrigatorio: false,
      padrao: "false",
      ajuda: "A sandbox da Shopee é outro host, não outro caminho: ligar isto"
        + " troca o endereço de todas as chamadas.",
    },
    {
      chave: "host", rotulo: "Host da API", tipo: "url", obrigatorio: false,
      ajuda: "Sobrescreve o host escolhido pela opção de sandbox. Em branco, use a opção acima.",
    },
    CAMPO_WEBHOOK,
    {
      chave: "verifyPush", rotulo: "Conferir assinatura do push", tipo: "booleano",
      obrigatorio: false, padrao: "false",
      ajuda: "Desligado por padrão porque a construção da assinatura da Shopee"
        + " não foi medida com dado real: um palpite errado derrubaria TODO aviso"
        + " com 404.",
    },
    {
      chave: "defaultWeightKg", rotulo: "Peso padrão (kg)", tipo: "numero",
      obrigatorio: false, padrao: "1",
      ajuda: "A Shopee exige peso no anúncio. Vale para produto sem peso cadastrado.",
    },
  ],

  OLX: [
    {
      chave: "clientId", rotulo: "Client ID", tipo: "texto", obrigatorio: true,
      ajuda: "Entregue pela OLX por aprovação manual; não há autoatendimento.",
    },
    {
      chave: "clientSecret", rotulo: "Client Secret", tipo: "segredo", obrigatorio: true,
      ajuda: "Chave secreta do cliente OAuth. Guardada cifrada.",
    },
    {
      chave: "apiUrl", rotulo: "URL da API", tipo: "url", obrigatorio: false,
      padrao: "https://apps.olx.com.br",
      ajuda: "Base do autoupload. Troque só se a OLX indicar outro endereço.",
    },
    {
      chave: "authUrl", rotulo: "URL de autorização", tipo: "url", obrigatorio: false,
      padrao: "https://auth.olx.com.br",
      ajuda: "Onde o anunciante autoriza a integração.",
    },
    {
      chave: "tokenUrl", rotulo: "URL de token", tipo: "url", obrigatorio: false,
      padrao: "https://auth.olx.com.br",
      ajuda: "Onde o código é trocado por token.",
    },
    {
      chave: "scope", rotulo: "Escopo do OAuth", tipo: "texto", obrigatorio: false,
      padrao: "basic_user_info autoupload",
      ajuda: "`autoupload` é o que permite publicar anúncio; sem ele a"
        + " autorização não serve para nada aqui.",
    },
  ],

  FACEBOOK: [
    {
      chave: "appId", rotulo: "App ID", tipo: "texto", obrigatorio: true,
      ajuda: "Identificador do SEU aplicativo no painel de desenvolvedores da"
        + " Meta, com o caso de uso de gerenciamento de catálogo habilitado.",
    },
    {
      chave: "appSecret", rotulo: "App Secret", tipo: "segredo", obrigatorio: true,
      ajuda: "Chave secreta do aplicativo. Usada para trocar o código pelo token"
        + " e para trocá-lo pelo de longa duração. Guardada cifrada.",
    },
    {
      chave: "catalogId", rotulo: "ID do catálogo", tipo: "texto", obrigatorio: true,
      ajuda: "Catálogo do Commerce Manager que recebe os produtos (só números)."
        + " É ele que abastece a loja do Facebook, do Instagram e -- para quem"
        + " está no programa de parceiros -- o Marketplace.",
    },
    {
      chave: "productUrlBase", rotulo: "Endereço base do produto", tipo: "url", obrigatorio: true,
      ajuda: "A Meta EXIGE um link de destino em cada item e recusa o que não"
        + " tem. O endereço do produto é montado como base + SKU"
        + " (ex.: https://sualoja.com.br/p → https://sualoja.com.br/p/SKU-123).",
    },
    {
      chave: "apiVersion", rotulo: "Versão da Graph API", tipo: "texto", obrigatorio: false,
      padrao: "v23.0", ajuda: "Cada versão da Graph API tem cerca de dois anos de"
        + " vida. Trocar aqui evita depender de deploy quando a atual for aposentada.",
    },
    {
      chave: "scope", rotulo: "Escopo do OAuth", tipo: "texto", obrigatorio: false,
      padrao: "catalog_management,business_management",
      ajuda: "Sem `catalog_management` o token não escreve no catálogo, e toda"
        + " publicação volta como falta de permissão.",
    },
    {
      chave: "authUrl", rotulo: "URL de autorização", tipo: "url", obrigatorio: false,
      padrao: "https://www.facebook.com",
      ajuda: "Onde a pessoa autoriza. Aceita apenas domínio da Meta.",
    },
    {
      chave: "graphUrl", rotulo: "URL da Graph API", tipo: "url", obrigatorio: false,
      padrao: "https://graph.facebook.com",
      ajuda: "Base das chamadas de token e de catálogo. Aceita apenas domínio da Meta.",
    },
  ],

  SEBO_ONLINE: [
    {
      chave: "apiUrl", rotulo: "URL da API do Sebo", tipo: "url", obrigatorio: true,
      ajuda: "Endereço público da loja, com o caminho do gateway se houver"
        + " (ex.: https://api-assets.sensedia.com/sebo/api). Exige HTTPS.",
    },
    CAMPO_WEBHOOK,
  ],
};

/// Provedores que a lista suspensa oferece, na ordem em que aparecem.
export const PROVEDORES: { provider: MarketplaceProvider; rotulo: string; nomeSugerido: string }[] = [
  { provider: "MERCADO_LIVRE", rotulo: "Mercado Livre", nomeSugerido: "Mercado Livre" },
  { provider: "SHOPEE", rotulo: "Shopee", nomeSugerido: "Shopee" },
  { provider: "OLX", rotulo: "OLX (classificados)", nomeSugerido: "OLX" },
  { provider: "FACEBOOK", rotulo: "Facebook (catálogo do Meta)", nomeSugerido: "Facebook" },
  { provider: "SEBO_ONLINE", rotulo: "Sebo On-Line", nomeSugerido: "Sebo Online" },
];

export function camposDoProvedor(provider: MarketplaceProvider): CampoDeConfig[] {
  return CAMPOS[provider] ?? [];
}

export function rotuloDoProvedor(provider: MarketplaceProvider): string {
  return PROVEDORES.find((p) => p.provider === provider)?.rotulo ?? provider;
}

/**
 * Slug do canal, derivado do provedor.
 *
 * Mantém os mesmos valores que o código digitado já usava (`mercado_livre`,
 * `shopee`, `olx`, `sebo`), porque tela, log e a tabela de categorias os
 * referenciam -- e porque assim os canais que já existem seguem casando.
 */
export function codigoDoProvedor(provider: MarketplaceProvider): string {
  switch (provider) {
    case "MERCADO_LIVRE": return "mercado_livre";
    case "SHOPEE": return "shopee";
    case "OLX": return "olx";
    case "FACEBOOK": return "facebook";
    case "SEBO_ONLINE": return "sebo";
  }
}

function urlValida(valor: string, rotulo: string): string {
  let url: URL;
  try { url = new URL(valor); } catch { throw new OrderError(`${rotulo}: URL inválida.`); }
  // Credencial não viaja em claro, e usuário/senha ou query na base viram
  // requisição para lugar diferente do que a tela mostra.
  if (url.protocol !== "https:") throw new OrderError(`${rotulo}: exige HTTPS.`);
  if (url.username || url.password || url.search || url.hash) {
    throw new OrderError(`${rotulo}: URL inválida.`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export interface ValorDeConfig {
  valor: string;
  segredo: boolean;
  buscavel: boolean;
}

/**
 * Valida e normaliza o que veio da tela, campo por campo do catálogo.
 *
 * Campo fora do catálogo é recusado em vez de ignorado: aceitar em silêncio
 * gravaria lixo que ninguém lê e esconderia erro de digitação na chave.
 * Campo vazio é REMOÇÃO -- devolvido como ausente, para o chamador apagar o
 * registro em vez de gravar string vazia, que passaria por "configurado".
 */
export function parseMarketplaceSettings(
  provider: MarketplaceProvider, entrada: unknown,
): Record<string, ValorDeConfig> {
  const dados = objectInput(entrada);
  const campos = camposDoProvedor(provider);
  const conhecidos = new Set(campos.map((c) => c.chave));
  for (const chave of Object.keys(dados)) {
    if (!conhecidos.has(chave)) {
      throw new OrderError(`Campo desconhecido para ${rotuloDoProvedor(provider)}: ${chave}.`);
    }
  }

  const saida: Record<string, ValorDeConfig> = {};
  for (const campo of campos) {
    const cru = dados[campo.chave];
    if (cru === undefined || cru === null) continue;
    if (typeof cru !== "string" && typeof cru !== "boolean" && typeof cru !== "number") {
      throw new OrderError(`${campo.rotulo}: valor inválido.`);
    }
    let valor = String(cru).trim();

    if (!valor) {
      if (campo.obrigatorio) throw new OrderError(`${campo.rotulo} é obrigatório.`);
      continue; // vazio = apagar
    }

    switch (campo.tipo) {
      case "url":
        valor = urlValida(valor, campo.rotulo);
        break;
      case "numero":
        if (!/^\d+(\.\d+)?$/.test(valor)) {
          throw new OrderError(`${campo.rotulo}: use apenas números.`);
        }
        break;
      case "booleano":
        if (valor !== "true" && valor !== "false") {
          throw new OrderError(`${campo.rotulo}: valor inválido.`);
        }
        break;
      case "segredo":
        if (campo.buscavel && valor.length < MINIMO_SEGREDO_WEBHOOK) {
          throw new OrderError(
            `${campo.rotulo}: mínimo de ${MINIMO_SEGREDO_WEBHOOK} caracteres.`);
        }
        break;
      case "texto":
        break;
    }

    saida[campo.chave] = {
      valor,
      segredo: campo.tipo === "segredo",
      buscavel: campo.buscavel === true,
    };
  }
  return saida;
}

/// Rótulos dos campos obrigatórios que continuam em branco. É o que a tela
/// mostra quando o canal não pode publicar: "o que falta", não "inválido".
export function faltaParaConfigurar(
  provider: MarketplaceProvider, preenchidas: Iterable<string>,
): string[] {
  const tem = new Set(preenchidas);
  return camposDoProvedor(provider)
    .filter((c) => c.obrigatorio && !tem.has(c.chave))
    .map((c) => c.rotulo);
}
