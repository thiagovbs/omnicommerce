import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { format } from "date-fns";

export async function GET(req: NextRequest) {
  const session = await auth();
  const orgId = (session?.user as any)?.organizationId;

  if (!orgId) {
    return new NextResponse("Não autorizado", { status: 401 });
  }

  try {
    // 1. Busca os dados das vendas
    const sales = await prisma.sale.findMany({
      where: { organizationId: orgId },
      include: { marketplace: true },
      orderBy: { soldAt: "desc" },
    });

    // 2. Inicializa o documento
    const doc = new jsPDF();
    const now = new Date();

    // Cabeçalho
    doc.setFontSize(18);
    doc.text("Relatório de Vendas", 14, 20);
    doc.setFontSize(10);
    doc.text(`Data de Emissão: ${format(now, "dd/MM/yyyy HH:mm")}`, 14, 28);

    // Configuração dos dados da tabela
    const tableColumn = ["Data", "Marketplace", "Pedido", "Status", "Líquido"];
    const tableRows = sales.map((sale) => [
      format(new Date(sale.soldAt), "dd/MM/yyyy"),
      sale.marketplace.name,
      sale.externalOrderId,
      sale.status,
      `R$ ${Number(sale.net).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`,
    ]);

    // 3. CHAMADA CORRETA: Usando a função autoTable diretamente
    // Em vez de doc.autoTable(), passamos o 'doc' como primeiro argumento
    autoTable(doc, {
      head: [tableColumn],
      body: tableRows,
      startY: 35,
      theme: 'striped',
      headStyles: { fillColor: [37, 99, 235] }, // Azul
      styles: { fontSize: 8 },
    });

    // 4. Gera o buffer e retorna
    const pdfOutput = doc.output("arraybuffer");

    return new NextResponse(pdfOutput, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=relatorio-vendas-${format(now, "yyyy-MM-dd")}.pdf`,
      },
    });

  } catch (error) {
    console.error("Erro ao gerar PDF:", error);
    return new NextResponse("Erro interno ao gerar relatório", { status: 500 });
  }
}