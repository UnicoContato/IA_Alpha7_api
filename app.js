const express = require('express');
const { requireIntEnv } = require('./src/config/env');

const { router } = require('./src/routes/buscaRoutes');


const app = express();
app.use(express.json());
app.use(router);

const PORT = requireIntEnv('PORT');
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
