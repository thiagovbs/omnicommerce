import { objectInput, OrderError, textInput } from "./order-input";

/**
 * Dados cadastrais de uma organização.
 *
 * Tudo opcional: uma organização nasce com o nome e ganha o resto quando
 * precisa. Quem exige um campo é quem o usa -- o anúncio da OLX pede telefone e
 * CEP, e é ele que nomeia a falta. Validar aqui serve para outra coisa: impedir
 * que um dado ERRADO entre, porque um CNPJ com dígito trocado só aparece no
 * boleto ou na nota do cliente, longe de quem digitou.
 */

function opcional(valor: unknown, rotulo: string, max: number) {
  if (valor === undefined || valor === null) return "";
  const texto = String(valor).trim();
  if (!texto) return "";
  return textInput(texto, rotulo, max);
}

function digitos(valor: unknown) {
  return String(valor ?? "").replace(/\D/g, "");
}

/**
 * Dígitos verificadores do CNPJ.
 *
 * Os dois últimos dígitos são calculados dos anteriores por módulo 11 com pesos
 * decrescentes que reiniciam em 9. É a mesma ideia do dígito do boleto e do
 * Luhn do cartão: pega erro de digitação, não fraude.
 */
export function cnpjValido(valor: string) {
  const numero = digitos(valor);
  if (numero.length !== 14) return false;
  // Sequência de um só algarismo passa na conta e não existe na vida real.
  if (/^(\d)\1{13}$/.test(numero)) return false;

  const dv = (ate: number) => {
    let peso = 2;
    let soma = 0;
    for (let i = ate - 1; i >= 0; i--) {
      soma += Number(numero[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(12) === Number(numero[12]) && dv(13) === Number(numero[13]);
}

const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

export interface OrganizationProfile {
  legalName: string;
  taxId: string;
  email: string;
  phone: string;
  zipCode: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
}

export function parseOrganizationProfile(input: unknown): OrganizationProfile {
  const value = objectInput(input);

  // Guardados só com dígitos: é como a OLX, o boleto e a nota os querem, e
  // normalizar na entrada evita decidir a máscara em cada leitura.
  const taxId = digitos(value.taxId);
  if (taxId && !cnpjValido(taxId)) throw new OrderError("CNPJ inválido.");

  const zipCode = digitos(value.zipCode);
  if (zipCode && zipCode.length !== 8) throw new OrderError("CEP deve ter 8 dígitos.");

  const phone = digitos(value.phone);
  if (phone && (phone.length < 10 || phone.length > 11)) {
    throw new OrderError("Telefone deve ter DDD e número (10 ou 11 dígitos).");
  }

  const email = opcional(value.email, "E-mail", 254).toLowerCase();
  // Conferência de forma, não de existência: e-mail sem arroba é erro de
  // digitação, e o resto só o envio descobre.
  if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    throw new OrderError("E-mail inválido.");
  }

  const state = opcional(value.state, "UF", 2).toUpperCase();
  if (state && !UFS.includes(state)) throw new OrderError("UF inválida.");

  return {
    legalName: opcional(value.legalName, "Razão social", 200),
    taxId,
    email,
    phone,
    zipCode,
    street: opcional(value.street, "Logradouro", 200),
    number: opcional(value.number, "Número", 20),
    complement: opcional(value.complement, "Complemento", 100),
    district: opcional(value.district, "Bairro", 100),
    city: opcional(value.city, "Cidade", 100),
    state,
  };
}

/// Campos que faltam para publicar classificado na OLX, em nome legível. A
/// mensagem de quem publica sai daqui, para a tela e o adapter dizerem o mesmo.
export function faltaParaAnunciar(perfil: Pick<OrganizationProfile, "phone" | "zipCode">) {
  const faltando: string[] = [];
  if (!perfil.phone) faltando.push("Telefone");
  if (!perfil.zipCode) faltando.push("CEP");
  return faltando;
}
