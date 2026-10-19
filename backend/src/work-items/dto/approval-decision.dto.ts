import { IsIn } from 'class-validator';

export class ApprovalDecisionDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';
}
