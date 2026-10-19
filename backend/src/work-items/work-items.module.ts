import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { ClaimService } from './claim.service.js';
import { WorkItemEditsService } from './work-item-edits.service.js';
import { WorkItemsController } from './work-items.controller.js';
import { WorkItemsService } from './work-items.service.js';
import { WorkflowService } from './workflow.service.js';

@Module({
  imports: [AuthModule, AuthorizationModule, IdempotencyModule],
  controllers: [WorkItemsController],
  providers: [
    WorkItemsService,
    ClaimService,
    WorkItemEditsService,
    WorkflowService,
  ],
})
export class WorkItemsModule {}
