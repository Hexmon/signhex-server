#!/usr/bin/env tsx
/**
 * Service Health Check Script
 * Checks if PostgreSQL and MinIO are accessible
 */

import { Client } from 'pg';
// import { loadConfig, getConfig } from '../src/config/index.js';
import { config as appConfig } from '../src/config/index.js';

async function checkPostgres() {
  console.log('🔍 Checking PostgreSQL connection...');
  
  try {
    const client = new Client({
      connectionString: appConfig.DATABASE_URL,
    });
    
    await client.connect();
    const result = await client.query('SELECT version()');
    console.log('✅ PostgreSQL is accessible');
    console.log(`   Version: ${result.rows[0].version.split(',')[0]}`);
    await client.end();
    return true;
  } catch (error: any) {
    console.error('❌ PostgreSQL connection failed');
    console.error(`   Error: ${error.message}`);
    console.error(`   Connection string: ${appConfig.DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);
    return false;
  }
}

async function checkMinIO() {
  console.log('\n🔍 Checking MinIO connection...');
  
  try {
    const protocol = appConfig.MINIO_USE_SSL ? 'https' : 'http';
    const url = `${protocol}://${appConfig.MINIO_ENDPOINT}:${appConfig.MINIO_PORT}/minio/health/live`;
    
    const response = await fetch(url);
    
    if (response.ok) {
      console.log('✅ MinIO is accessible');
      console.log(`   Endpoint: ${appConfig.MINIO_ENDPOINT}:${appConfig.MINIO_PORT}`);
      return true;
    } else {
      console.error('❌ MinIO health check failed');
      console.error(`   Status: ${response.status}`);
      return false;
    }
  } catch (error: any) {
    console.error('❌ MinIO connection failed');
    console.error(`   Error: ${error.message}`);
    console.error(`   Endpoint: ${appConfig.MINIO_ENDPOINT}:${appConfig.MINIO_PORT}`);
    return false;
  }
}

async function main() {
  console.log('🚀 Hexmon Signage - Service Health Check\n');
  console.log('=' .repeat(50));
  
  const postgresOk = await checkPostgres();
  const minioOk = await checkMinIO();
  
  console.log('\n' + '='.repeat(50));
  console.log('\n📊 Summary:');
  console.log(`   PostgreSQL: ${postgresOk ? '✅ OK' : '❌ FAILED'}`);
  console.log(`   MinIO:      ${minioOk ? '✅ OK' : '❌ FAILED'}`);
  
  if (!postgresOk || !minioOk) {
    console.log('\n⚠️  Some services are not available.');
    console.log('\n💡 To start services with Docker:');
    console.log('   docker-compose up -d postgres minio');
    console.log('\n💡 Or install services locally:');
    console.log('   - PostgreSQL: https://www.postgresql.org/download/');
    console.log('   - MinIO: https://min.io/download');
    process.exit(1);
  }
  
  console.log('\n✅ All services are healthy!');
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

