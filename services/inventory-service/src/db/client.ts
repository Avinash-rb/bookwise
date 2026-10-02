import { Pool } from 'pg'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

const pool = new Pool({
  connectionString: process.env.INVENTORY_DB_URL,
  max: 10,                // max 10 connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

// Test connection on startup
pool.on('connect', () => {
  console.log('✅ Inventory DB connected')
})

pool.on('error', (err) => {
  console.error('❌ Inventory DB pool error:', err)
})

export default pool
