import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithUser } from '../auth/jwt-auth.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ClaimService } from './claim.service.js';
import { ApprovalDecisionDto } from './dto/approval-decision.dto.js';
import { CreateWorkItemDto } from './dto/create-work-item.dto.js';
import { ListWorkItemsDto } from './dto/list-work-items.dto.js';
import { UpdateWorkItemDto } from './dto/update-work-item.dto.js';
import { WorkItemEditsService } from './work-item-edits.service.js';
import { WorkItemsService } from './work-items.service.js';
import { WorkflowService } from './workflow.service.js';

@Controller('work-items')
@UseGuards(JwtAuthGuard)
export class WorkItemsController {
  constructor(
    private readonly workItemsService: WorkItemsService,
    private readonly claimService: ClaimService,
    private readonly editsService: WorkItemEditsService,
    private readonly workflowService: WorkflowService,
  ) {}

  @Post()
  async create(
    @Req() request: RequestWithUser,
    @Body() dto: CreateWorkItemDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res() response: Response,
  ) {
    if (!key?.trim() || key.length > 200) {
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    }

    const result = await this.workItemsService.create(
      request.user,
      dto,
      key.trim(),
    );

    response.setHeader(
      'ETag',
      `"${(result.body as { version: number }).version}"`,
    );

    return response.status(result.status).json(result.body);
  }

  @Get()
  list(
    @Req() request: RequestWithUser,
    @Query() filters: ListWorkItemsDto,
  ) {
    return this.workItemsService.list(request.user, filters);
  }

  @Post(':id/claim')
  async claim(
    @Req() request: RequestWithUser,
    @Param('id', ParseUUIDPipe) itemId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res() response: Response,
  ) {
    if (!key?.trim() || key.length > 200) {
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    }

    const result = await this.claimService.claim(
      request.user,
      itemId,
      key.trim(),
    );

    if (
      result.status === 200 &&
      typeof result.body === 'object' &&
      result.body !== null &&
      'item' in result.body
    ) {
      const item = (result.body as { item: { version: number } }).item;
      response.setHeader('ETag', `"${item.version}"`);
    }

    return response.status(result.status).json(result.body);
  }

  @Patch(':id')
  async update(
    @Req() request: RequestWithUser,
    @Param('id', ParseUUIDPipe) itemId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateWorkItemDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!ifMatch) {
      throw new HttpException('If-Match header is required', 428);
    }

    const match = /^"([1-9]\d*)"$/.exec(ifMatch.trim());

    if (!match) {
      throw new BadRequestException(
        'If-Match must be a strong version ETag, e.g. "1"',
      );
    }

    const item = await this.editsService.update(
      request.user,
      itemId,
      Number(match[1]),
      dto,
    );

    response.setHeader('ETag', `"${item.version}"`);
    return item;
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  async startWork(
    @Req() request: RequestWithUser,
    @Param('id', ParseUUIDPipe) itemId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const item = await this.workflowService.startWork(
      request.user,
      itemId,
    );

    response.setHeader('ETag', `"${item.version}"`);
    return item;
  }
  @Post(':id/request-approval')
  @HttpCode(HttpStatus.OK)
  async requestApproval(
    @Req() request: RequestWithUser,
    @Param('id', ParseUUIDPipe) itemId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const item = await this.workflowService.requestApproval(
      request.user,
      itemId,
    );

    response.setHeader('ETag', `"${item.version}"`);
    return item;
  }

  @Post(':id/approval-decision')
  @HttpCode(HttpStatus.OK)
  async decideApproval(
    @Req() request: RequestWithUser,
    @Param('id', ParseUUIDPipe) itemId: string,
    @Body() dto: ApprovalDecisionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const item = await this.workflowService.decideApproval(
      request.user,
      itemId,
      dto,
    );

    response.setHeader('ETag', `"${item.version}"`);
    return item;
  }

  @Get(':id')
  async findOne(
    @Req() request: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const item = await this.workItemsService.findOne(request.user, id);
    response.setHeader('ETag', `"${item.version}"`);
    return item;
  }
}
