# Cuestionario del proceso comercial

Formulario con IA que documenta cómo vende un negocio antes de construirle su agente.

- Reglas del proyecto: [`AGENTS.md`](AGENTS.md)
- Plan y decisiones: [`docs/PLAN.md`](docs/PLAN.md)
- Deploy: [`docs/EASYPANEL.md`](docs/EASYPANEL.md)

## En local

```bash
npm install
cp .env.example .env
npm run dev
```

Sin `DATABASE_URL` usa una base embebida en `data/pglite`, así que no hace falta Docker. El
estado del sistema está en http://localhost:3000/api/salud.

## Pruebas

```bash
npm run prueba
```

No llaman a Claude: el motor se prueba con una IA falsa.

## Simulador

Con `ANTHROPIC_API_KEY` en `.env`, dueños de negocio inventados completan el cuestionario contra
Claude real:

```bash
npm run simular -- clinica
```

Deja el cuestionario generado, la transcripción y el costo aproximado en `pruebas/salidas/`.
