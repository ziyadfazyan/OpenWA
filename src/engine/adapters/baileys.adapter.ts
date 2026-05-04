import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  generateForwardMessageContent,
  getContentType,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  proto,
  useMultiFileAuthState,
  type Contact as BaileysContact,
  type AnyMessageContent,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys';
import * as qrcode from 'qrcode';
import { createLogger } from '../../common/services/logger.service';
import {
  type Catalog,
  type Channel,
  type ChannelMessage,
  type Contact,
  type ContactCard,
  type EngineEventCallbacks,
  EngineStatus,
  type Group,
  type GroupInfo,
  type GroupParticipant,
  type IWhatsAppEngine,
  type IncomingMessage,
  type Label,
  type LocationInput,
  type MediaInput,
  type MessageReaction,
  type MessageResult,
  type PaginatedProducts,
  type Product,
  type ProductQueryOptions,
  type Status,
  type StatusResult,
  type TextStatusOptions,
} from '../interfaces/whatsapp-engine.interface';

export interface BaileysConfig {
  sessionId: string;
  sessionDataPath: string;
}

type BaileysGroupParticipant = {
  id: string;
  admin?: string | null;
  name?: string;
};

type BaileysContactUpdate = Partial<BaileysContact> & {
  id?: string;
};

type BaileysGroupRecord = {
  id: string;
  subject: string;
  participants?: BaileysGroupParticipant[];
  desc?: string;
  owner?: string;
  creation?: number;
  descOwner?: string;
  announce?: boolean;
};

export class BaileysAdapter extends EventEmitter implements IWhatsAppEngine {
  private readonly logger = createLogger('BaileysAdapter');
  private readonly authPath: string;
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private callbacks: EngineEventCallbacks = {};
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private readonly messageCache = new Map<string, WAMessage>();
  private readonly contactCache = new Map<string, Contact>();

  constructor(private readonly config: BaileysConfig) {
    super();
    this.authPath = path.resolve(this.config.sessionDataPath, 'baileys', this.config.sessionId);
  }

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);
    fs.mkdirSync(this.authPath, { recursive: true });

    if (this.socket) {
      await this.destroy();
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu('OpenWA'),
    });

    this.socket.ev.on('creds.update', () => {
      void saveCreds().catch(error => {
        this.logger.error('Failed to persist Baileys credentials', error);
      });
    });

    this.socket.ev.on('connection.update', async update => {
      if (update.qr) {
        this.qrCode = await qrcode.toDataURL(update.qr);
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      }

      if (update.connection === 'open') {
        const userId = this.socket?.user?.id ? jidNormalizedUser(this.socket.user.id) : null;
        this.phoneNumber = userId ? userId.split('@')[0] ?? null : null;
        this.pushName = this.socket?.user?.name ?? null;
        this.qrCode = null;
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.(this.phoneNumber ?? '', this.pushName ?? '');
      }

      if (update.connection === 'close') {
        const statusCode = this.getDisconnectCode(update.lastDisconnect?.error);

        if (statusCode === DisconnectReason.loggedOut) {
          this.setStatus(EngineStatus.FAILED);
          this.callbacks.onDisconnected?.('Baileys logged out');
          return;
        }

        this.setStatus(EngineStatus.DISCONNECTED);
        this.callbacks.onDisconnected?.('Baileys connection closed');
      }
    });

    this.socket.ev.on('contacts.upsert', (contacts: BaileysContact[]) => {
      for (const contact of contacts) {
        this.storeContact(contact);
      }
    });

    this.socket.ev.on('contacts.update', (contacts: BaileysContactUpdate[]) => {
      for (const contact of contacts) {
        this.mergeContact(contact);
      }
    });

    this.socket.ev.on('messages.upsert', ({ messages }) => {
      for (const message of messages) {
        this.storeMessage(message);
        this.callbacks.onMessage?.(this.mapIncomingMessage(message));
      }
    });
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      this.setStatus(EngineStatus.DISCONNECTED);
      return;
    }

    this.socket.end(new Error('Baileys disconnect requested'));
    this.socket = null;
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  async logout(): Promise<void> {
    if (this.socket) {
      try {
        await this.socket.logout('Baileys logout requested');
      } catch (error) {
        this.logger.warn('Baileys logout failed, closing socket instead', String(error));
        this.socket.end(new Error('Baileys logout fallback'));
      }

      this.socket = null;
    }

    fs.rmSync(this.authPath, { recursive: true, force: true });
    this.clearSessionState();
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  async destroy(): Promise<void> {
    if (this.socket) {
      this.socket.end(new Error('Baileys destroy requested'));
      this.socket = null;
    }

    this.clearSessionState();
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    const message = await this.sendMessage(chatId, { text });
    return this.extractMessageResult(message);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, 'image');
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, 'video');
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, 'audio');
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, 'document');
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    const message = await this.sendMessage(chatId, {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        name: location.description,
        address: location.address,
      },
    });

    return this.extractMessageResult(message);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    const message = await this.sendMessage(chatId, {
      contacts: {
        displayName: contact.name,
        contacts: [{ displayName: contact.name, vcard }],
      },
    });

    return this.extractMessageResult(message);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, 'sticker');
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();

    const quoted = this.messageCache.get(quotedMsgId);
    if (!quoted) {
      throw new Error(`Message ${quotedMsgId} not found in Baileys cache`);
    }

    const message = await this.socket!.sendMessage(this.normalizeJid(chatId), { text }, { quoted });
    return this.extractMessageResult(message);
  }

  async forwardMessage(_fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();

    const original = this.messageCache.get(messageId);
    if (!original) {
      throw new Error(`Message ${messageId} not found in Baileys cache`);
    }

    const forwardedContent = generateForwardMessageContent(original, true);
    const forwardedMessageId = this.createMessageId();

    await this.socket!.relayMessage(this.normalizeJid(toChatId), forwardedContent, {
      messageId: forwardedMessageId,
    });

    return {
      id: forwardedMessageId,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();

    const original = this.messageCache.get(messageId);
    const key: WAMessageKey =
      original?.key ?? {
        remoteJid: this.normalizeJid(chatId),
        fromMe: false,
        id: messageId,
      };

    await this.socket!.sendMessage(this.normalizeJid(chatId), {
      react: {
        text: emoji,
        key,
      },
    });
  }

  async getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    return [];
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    const contacts = Array.from(this.contactCache.values());
    const currentUser = this.getCurrentUserContact();

    if (currentUser && !contacts.some(contact => contact.id === currentUser.id)) {
      contacts.unshift(currentUser);
    }

    return contacts;
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();

    const jid = this.normalizeJid(contactId);
    const cached = this.contactCache.get(jid);
    if (cached) {
      return cached;
    }

    if (this.getSelfJid() === jid) {
      return this.getCurrentUserContact();
    }

    return null;
  }

  async checkNumberExists(number: string): Promise<boolean> {
    this.ensureReady();

    const normalized = this.normalizeJid(number);
    const result = await this.socket!.onWhatsApp(normalized);
    return Boolean(result?.[0]?.exists);
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();

    const groups = (await this.socket!.groupFetchAllParticipating()) as Record<string, BaileysGroupRecord>;
    const selfJid = this.getSelfJid();

    return Object.values(groups).map(group => ({
      id: group.id,
      name: group.subject,
      participantsCount: group.participants?.length,
      isAdmin:
        Boolean(selfJid) &&
        (group.participants ?? []).some(
          (participant: BaileysGroupParticipant) => participant.id === selfJid && participant.admin !== undefined,
        ),
    }));
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();

    try {
      const group = (await this.socket!.groupMetadata(this.normalizeJid(groupId))) as BaileysGroupRecord;

      return {
        id: group.id,
        name: group.subject,
        description: group.desc,
        owner: group.owner,
        createdAt: group.creation,
        participants: (group.participants ?? []).map((participant: BaileysGroupParticipant) =>
          this.mapGroupParticipant(participant),
        ),
        isReadOnly: Boolean(group.descOwner),
        isAnnounce: Boolean(group.announce),
      };
    } catch (error) {
      this.logger.warn(`Failed to get Baileys group info for ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();

    const result = await this.socket!.groupCreate(name, participants.map(participant => this.normalizeJid(participant)));

    return {
      id: result.id,
      name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.socket!.groupParticipantsUpdate(this.normalizeJid(groupId), participants.map(participant => this.normalizeJid(participant)), 'add');
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.socket!.groupParticipantsUpdate(this.normalizeJid(groupId), participants.map(participant => this.normalizeJid(participant)), 'remove');
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.socket!.groupParticipantsUpdate(this.normalizeJid(groupId), participants.map(participant => this.normalizeJid(participant)), 'promote');
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.socket!.groupParticipantsUpdate(this.normalizeJid(groupId), participants.map(participant => this.normalizeJid(participant)), 'demote');
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    await this.socket!.groupLeave(this.normalizeJid(groupId));
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    await this.socket!.groupUpdateSubject(this.normalizeJid(groupId), subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    await this.socket!.groupUpdateDescription(this.normalizeJid(groupId), description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    return (await this.socket!.groupInviteCode(this.normalizeJid(groupId))) ?? '';
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    return (await this.socket!.groupRevokeInvite(this.normalizeJid(groupId))) ?? '';
  }

  async deleteMessage(chatId: string, messageId: string, _forEveryone?: boolean): Promise<void> {
    this.ensureReady();
    const original = this.messageCache.get(messageId);

    await this.socket!.sendMessage(this.normalizeJid(chatId), {
      delete: original?.key ?? {
        remoteJid: this.normalizeJid(chatId),
        fromMe: false,
        id: messageId,
      },
    });
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();

    try {
      return (await this.socket!.profilePictureUrl(this.normalizeJid(contactId), 'image')) ?? null;
    } catch {
      return null;
    }
  }

  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    await this.socket!.updateBlockStatus(this.normalizeJid(contactId), 'block');
  }

  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    await this.socket!.updateBlockStatus(this.normalizeJid(contactId), 'unblock');
  }

  async getLabels(): Promise<Label[]> {
    return [];
  }

  async getLabelById(_labelId: string): Promise<Label | null> {
    return null;
  }

  async getChatLabels(_chatId: string): Promise<Label[]> {
    return [];
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.socket!.addChatLabel(this.normalizeJid(chatId), labelId);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.socket!.removeChatLabel(this.normalizeJid(chatId), labelId);
  }

  async getSubscribedChannels(): Promise<Channel[]> {
    return [];
  }

  async getChannelById(_channelId: string): Promise<Channel | null> {
    return null;
  }

  async subscribeToChannel(_inviteCode: string): Promise<Channel> {
    throw new Error('Baileys channel subscription is not implemented in this adapter yet');
  }

  async unsubscribeFromChannel(_channelId: string): Promise<void> {
    throw new Error('Baileys channel unsubscription is not implemented in this adapter yet');
  }

  async getChannelMessages(_channelId: string, _limit?: number): Promise<ChannelMessage[]> {
    return [];
  }

  async getContactStatuses(): Promise<Status[]> {
    return [];
  }

  async getContactStatus(_contactId: string): Promise<Status[]> {
    return [];
  }

  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    throw new Error('Baileys status publishing is not implemented in this adapter yet');
  }

  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    throw new Error('Baileys status publishing is not implemented in this adapter yet');
  }

  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    throw new Error('Baileys status publishing is not implemented in this adapter yet');
  }

  async deleteStatus(_statusId: string): Promise<void> {
    throw new Error('Baileys status deletion is not implemented in this adapter yet');
  }

  async getCatalog(): Promise<Catalog | null> {
    return null;
  }

  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    return {
      products: [],
      pagination: {
        page: _options?.page ?? 1,
        limit: _options?.limit ?? 20,
        total: 0,
        totalPages: 0,
      },
    };
  }

  async getProduct(_productId: string): Promise<Product | null> {
    return null;
  }

  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    throw new Error('Baileys catalog sending is not implemented in this adapter yet');
  }

  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    throw new Error('Baileys catalog sending is not implemented in this adapter yet');
  }

  private async sendMediaMessage(chatId: string, media: MediaInput, field: 'image' | 'video' | 'audio' | 'document' | 'sticker'): Promise<MessageResult> {
    try {
      const content = {
        [field]: await this.resolveMediaPayload(media.data),
      } as unknown as AnyMessageContent;

      if (media.caption) {
        (content as Record<string, unknown>).caption = media.caption;
      }

      if (media.filename) {
        (content as Record<string, unknown>).fileName = media.filename;
      }

      if (media.mimetype) {
        (content as Record<string, unknown>).mimetype = media.mimetype;
      }

      // Validate image format for thumbnails
      if (field === 'image' && media.mimetype && !media.mimetype.startsWith('image/')) {
        throw new Error(`Unsupported image format: ${media.mimetype}`);
      }

      this.logger.debug(`Sending media message to ${chatId} with field ${field}`);

      const message = await this.sendMessage(chatId, content);
      return this.extractMessageResult(message);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to send media message to ${chatId} with field ${field}: ${err.message}`);

      // Handle unsupported image format gracefully
      if (err.message.includes('unsupported image format')) {
        throw new Error('The provided image format is not supported. Please use a standard format like JPEG or PNG.');
      }

      throw new Error(`Failed to send ${field} message: ${err.message}`);
    }
  }

  private async sendMessage(chatId: string, content: AnyMessageContent): Promise<WAMessage | undefined> {
    this.ensureReady();
    return this.socket!.sendMessage(this.normalizeJid(chatId), content, {
      mediaUploadTimeoutMs: 60000,
    });
  }

  private ensureReady(): void {
    if (!this.socket || this.status !== EngineStatus.READY) {
      throw new Error(`Baileys engine is not ready (current status: ${this.status})`);
    }
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  private clearSessionState(): void {
    this.messageCache.clear();
    this.contactCache.clear();
    this.qrCode = null;
    this.phoneNumber = null;
    this.pushName = null;
  }

  private storeMessage(message: WAMessage): void {
    const messageId = message.key.id ?? this.createMessageId();
    this.messageCache.set(messageId, message);

    const senderJid = message.key.participant ?? message.key.remoteJid ?? '';
    if (senderJid) {
      const jid = this.normalizeJid(senderJid);
      this.contactCache.set(jid, {
        id: jid,
        name: message.pushName ?? undefined,
        pushName: message.pushName ?? undefined,
        number: jid.split('@')[0] ?? jid,
        isMyContact: false,
        isBlocked: false,
      });
    }
  }

  private storeContact(contact: BaileysContact): void {
    const jid = this.normalizeJid(contact.id);
    const current = this.contactCache.get(jid) ?? {
      id: jid,
      number: jid.split('@')[0] ?? jid,
      isMyContact: false,
      isBlocked: false,
    };

    this.contactCache.set(jid, {
      ...current,
      id: jid,
      name: contact.name ?? current.name,
      pushName: contact.notify ?? current.pushName,
      number: jid.split('@')[0] ?? jid,
      isMyContact: Boolean((contact as { isMyContact?: boolean }).isMyContact ?? current.isMyContact),
      isBlocked: Boolean((contact as { isBlocked?: boolean }).isBlocked ?? current.isBlocked),
      profilePicUrl: contact.imgUrl ?? current.profilePicUrl,
    });
  }

  private mergeContact(contact: BaileysContactUpdate): void {
    if (!contact.id) {
      return;
    }

    const jid = this.normalizeJid(contact.id);
    const current = this.contactCache.get(jid) ?? {
      id: jid,
      number: jid.split('@')[0] ?? jid,
      isMyContact: false,
      isBlocked: false,
    };

    this.contactCache.set(jid, {
      ...current,
      id: jid,
      name: contact.name ?? current.name,
      pushName: contact.notify ?? current.pushName,
      number: jid.split('@')[0] ?? jid,
      isMyContact: Boolean((contact as { isMyContact?: boolean }).isMyContact ?? current.isMyContact),
      isBlocked: Boolean((contact as { isBlocked?: boolean }).isBlocked ?? current.isBlocked),
      profilePicUrl: contact.imgUrl ?? current.profilePicUrl,
    });
  }

  private mapIncomingMessage(message: WAMessage): IncomingMessage {
    const contentType = getContentType(message.message ?? undefined);
    const remoteJid = message.key.remoteJid ?? message.key.participant ?? '';
    const senderJid = message.key.participant ?? remoteJid;

    return {
      id: message.key.id ?? this.createMessageId(),
      from: senderJid,
      to: remoteJid,
      chatId: remoteJid,
      body: this.extractMessageBodyFromContent(message.message),
      type: contentType ?? 'unknown',
      timestamp: Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)),
      fromMe: Boolean(message.key.fromMe),
      isGroup: remoteJid.endsWith('@g.us'),
      quotedMessage: this.extractQuotedMessage(message),
    };
  }

  private extractMessageBodyFromContent(content: WAMessage['message']): string {
    const contentType = getContentType(content ?? undefined);
    if (!content || !contentType) {
      return '';
    }

    const typedContent = content as Record<string, unknown>;

    switch (contentType) {
      case 'conversation':
        return (typedContent.conversation as string | undefined) ?? '';
      case 'extendedTextMessage':
        return ((typedContent.extendedTextMessage as { text?: string } | undefined)?.text ?? '').toString();
      case 'imageMessage':
        return ((typedContent.imageMessage as { caption?: string } | undefined)?.caption ?? '').toString();
      case 'videoMessage':
        return ((typedContent.videoMessage as { caption?: string } | undefined)?.caption ?? '').toString();
      case 'documentMessage':
        return ((typedContent.documentMessage as { caption?: string } | undefined)?.caption ?? '').toString();
      case 'locationMessage':
        return ((typedContent.locationMessage as { name?: string; address?: string } | undefined)?.name ?? '').toString();
      case 'contactMessage':
        return ((typedContent.contactMessage as { displayName?: string } | undefined)?.displayName ?? '').toString();
      default:
        return '';
    }
  }

  private extractQuotedMessage(message: WAMessage): IncomingMessage['quotedMessage'] {
    const contextInfo = message.message?.extendedTextMessage?.contextInfo;
    const quotedMessage = contextInfo?.quotedMessage;
    const quotedId = contextInfo?.stanzaId;

    if (!quotedMessage || !quotedId) {
      return undefined;
    }

    return {
      id: quotedId,
      body: this.extractMessageBodyFromContent(quotedMessage),
    };
  }

  private mapGroupParticipant(participant: BaileysGroupParticipant): GroupParticipant {
    const jid = participant.id ? this.normalizeJid(participant.id) : '';

    return {
      id: jid,
      number: jid.split('@')[0] ?? jid,
      name: participant.name,
      isAdmin: participant.admin === 'admin' || participant.admin === 'superadmin',
      isSuperAdmin: participant.admin === 'superadmin',
    };
  }

  private getCurrentUserContact(): Contact | null {
    const selfJid = this.getSelfJid();

    if (!selfJid) {
      return null;
    }

    return {
      id: selfJid,
      name: this.pushName ?? undefined,
      pushName: this.pushName ?? undefined,
      number: selfJid.split('@')[0] ?? selfJid,
      isMyContact: true,
      isBlocked: false,
    };
  }

  private getSelfJid(): string | null {
    if (!this.socket?.user?.id) {
      return null;
    }

    return jidNormalizedUser(this.socket.user.id);
  }

  private normalizeJid(value: string): string {
    if (value.includes('@')) {
      return jidNormalizedUser(value);
    }

    return jidNormalizedUser(`${value}@s.whatsapp.net`);
  }

  private async resolveMediaPayload(data: Buffer | string): Promise<Buffer | { url: string }> {
    if (Buffer.isBuffer(data)) {
      return data;
    }

    if (data.startsWith('http://') || data.startsWith('https://')) {
      return { url: data };
    }

    const base64 = data.startsWith('data:') ? data.split(',')[1] ?? '' : data;
    return Buffer.from(base64, 'base64');
  }

  private extractMessageResult(message: WAMessage | undefined): MessageResult {
    if (!message?.key?.id) {
      throw new Error('Baileys did not return a message id');
    }

    return {
      id: message.key.id,
      timestamp: Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    };
  }

  private createMessageId(): string {
    return `baileys_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private getDisconnectCode(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') {
      return undefined;
    }

    const candidate = error as { output?: { statusCode?: number } };
    return candidate.output?.statusCode;
  }
}
