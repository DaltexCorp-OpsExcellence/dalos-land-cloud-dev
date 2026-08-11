#!/usr/bin/env node
// Dump the block-matching index + live metric registry to gitignored JSON, for the
// history loader. Matches workbook history rows to blocks by (farm_code, aydi) with a
// cost-centre / rootstock / variety / planting-year tie-break — NEVER the op-id.
const fs = require("fs"), path = require("path");
const { Client } = require("pg");
function loadEnv(){ if(process.env.DATABASE_URL) return; const p=path.join(__dirname,"..",".env"); if(!fs.existsSync(p))return;
  for(const line of fs.readFileSync(p,"utf8").split(/\r?\n/)){ const m=line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^["']|["']$/g,""); } }
loadEnv();
function connConfig(){ const base={ssl:{rejectUnauthorized:false}};
  if(process.env.DB_PASSWORD){ const u=new URL(process.env.DATABASE_URL);
    return Object.assign(base,{host:u.hostname,port:+u.port||5432,user:decodeURIComponent(u.username),database:u.pathname.replace(/^\//,"")||"postgres",password:process.env.DB_PASSWORD}); }
  return Object.assign(base,{connectionString:process.env.DATABASE_URL}); }
(async()=>{
  const c=new Client(connConfig()); await c.connect();
  const blocks=(await c.query(`
    select b.id, b.product_id, b.farm_code, b.aydi_block_number, b.jde_cost_center_id,
           b.planting_year, b.lifecycle, r.code as rootstock_code, v.code as variety_code, v.name as variety_name
    from farm_blocks b
    left join farm_rootstocks r on r.id=b.rootstock_id
    left join varieties v on v.id=b.variety_id
    order by b.product_id, b.farm_code, b.aydi_block_number`)).rows;
  const metrics=(await c.query(`select code, aliases from farm_metrics`)).rows;
  await c.end();
  fs.writeFileSync(path.join(__dirname,"blocks_match.json"), JSON.stringify(blocks));
  fs.writeFileSync(path.join(__dirname,"metrics_live.json"), JSON.stringify(metrics));
  console.log("blocks:",blocks.length," metrics:",metrics.length,"-> scripts/blocks_match.json, metrics_live.json");
})().catch(e=>{console.error("FAILED:",e.message);process.exit(1);});
