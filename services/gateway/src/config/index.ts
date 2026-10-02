import dotenv from 'dotenv'
dotenv.config({ path: '../../.env' }) // loads root .env

const config = {
  port: parseInt(process.env.GATEWAY_PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'bookwise_dev_secret',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Downstream service URLs (we'll call these directly for now)
  services: {
    order:     process.env.ORDER_SERVICE_URL     || 'http://localhost:3001',
    inventory: process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002',
    payment:   process.env.PAYMENT_SERVICE_URL   || 'http://localhost:3003',
  }
}

export default config
