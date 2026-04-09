const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(__dirname, '../../.env')
});

function requireEnv(nome) {
  const valor = String(process.env[nome] ?? '').trim();

  if (!valor) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${nome}`);
  }

  return valor;
}

function requireIntEnv(nome) {
  const valor = requireEnv(nome);
  const convertido = Number.parseInt(valor, 10);

  if (!Number.isFinite(convertido)) {
    throw new Error(`Variavel de ambiente invalida para numero inteiro: ${nome}=${valor}`);
  }

  return convertido;
}

function getEnv(nome, fallback = '') {
  const valor = String(process.env[nome] ?? '').trim();
  return valor || fallback;
}

module.exports = {
  getEnv,
  requireEnv,
  requireIntEnv
};
