import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { TeamsModule } from './teams/teams.module.js';
import { WorkItemsModule } from './work-items/work-items.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('DATABASE_URL_APP');

        if (!url) {
          throw new Error('DATABASE_URL_APP is missing from backend/.env');
        }

        return {
          type: 'postgres' as const,
          url,
          autoLoadEntities: true,
          synchronize: false,
          logging: false,
        };
      },
    }),
    AuthModule,
    AuthorizationModule,
    TeamsModule,
    WorkItemsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
