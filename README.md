1.  **Clonar o repositório:**
    ```bash
    git clone https://github.com/seu-usuario/omniapp-v2.git
    cd omniapp-v2
    ```

2.  **Configurar Variáveis de Ambiente:**
    Crie um arquivo `.env` na raiz:
    ```env
    DATABASE_URL="postgresql://johndoe:randompassword@localhost:5432/omniapp?schema=public"
    AUTH_SECRET="sua_chave_secreta_aqui"
    ```

3.  **Subir o Banco de Dados (Docker):**
    ```bash
    docker-compose up -d
    ```

4.  **Instalar dependências:**
    ```bash
    npm install
    ```

5.  **Sincronizar o Banco de Dados (Migrations):**
    ```bash
    npx prisma migrate dev
    ```

6.  **Iniciar o Servidor de Desenvolvimento:**
    ```bash
    npm run dev
    ```
    Acesse: [http://localhost:3000](http://localhost:3000)

## 📊 Scripts Úteis

* `npx prisma studio`: Abre a interface visual para gerir os dados do banco.
* `npm run build`: Gera a versão de produção otimizada.
* `npm run lint`: Verifica erros de padronização no código.
