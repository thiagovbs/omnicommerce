"use client";

import { useState } from "react";
import { Eye, X } from "lucide-react";

interface AuditDetailModalProps {
  action: string;
  oldData: any;
  newData: any;
}

export function AuditDetailModal({ action, oldData, newData }: AuditDetailModalProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Se não houver dados para comparar (ex: um delete simples ou login)
  if (!oldData && !newData) return null;

  // Pegamos todas as chaves únicas presentes em ambos os objetos
  const allKeys = Array.from(new Set([
    ...Object.keys(oldData || {}),
    ...Object.keys(newData || {})
  ])).filter(key => key !== "updatedAt" && key !== "createdAt"); // Removemos metadados irrelevantes

  return (
    <>
      <button 
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-1 text-blue-600 hover:text-blue-800 font-medium transition-colors"
      >
        <Eye size={14} /> Ver Alterações
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center bg-gray-50 rounded-t-2xl">
              <h3 className="text-lg font-bold text-gray-900">Detalhes da Alteração ({action})</h3>
              <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <div className="grid grid-cols-3 gap-4 mb-4 text-xs font-bold text-gray-400 uppercase tracking-wider">
                <span>Campo</span>
                <span>Anterior</span>
                <span>Novo</span>
              </div>

              <div className="space-y-3">
                {allKeys.map((key) => {
                  const valOld = oldData?.[key];
                  const valNew = newData?.[key];
                  const isChanged = JSON.stringify(valOld) !== JSON.stringify(valNew);

                  return (
                    <div 
                      key={key} 
                      className={`grid grid-cols-3 gap-4 py-2 px-3 rounded-lg text-sm border ${
                        isChanged ? "bg-amber-50 border-amber-100" : "bg-gray-50 border-gray-100"
                      }`}
                    >
                      <span className="font-mono font-semibold text-gray-700">{key}</span>
                      <span className="text-red-600 truncate">{String(valOld ?? "-")}</span>
                      <span className={`font-bold truncate ${isChanged ? "text-green-600" : "text-gray-600"}`}>
                        {String(valNew ?? "-")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-4 border-t bg-gray-50 text-right rounded-b-2xl">
              <button 
                onClick={() => setIsOpen(false)}
                className="bg-gray-900 text-white px-6 py-2 rounded-lg font-medium hover:bg-gray-800 transition-colors"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}