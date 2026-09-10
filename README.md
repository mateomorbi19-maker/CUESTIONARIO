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
