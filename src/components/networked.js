var naf = require('../NafIndex');
var componentHelper = require('../ComponentHelper');
var Compressor = require('../Compressor');
var bind = AFRAME.utils.bind;

AFRAME.registerComponent('networked', {
  schema: {
    template: {default: ''},
    showLocalTemplate: {default: true},

    networkId: {default: ''},
    owner: {default: ''},
    components: {default: ['position', 'rotation']},
  },

  init: function() {
    var data = this.data;
    var wasCreatedByNetwork = this.wasCreatedByNetwork();

    this.onLoggedIn = bind(this.onLoggedIn, this);
    this.syncAll = bind(this.syncAll, this);
    this.syncDirty = bind(this.syncDirty, this);
    this.networkUpdateHandler = bind(this.networkUpdateHandler, this);

    this.cachedData = {};
    this.framesSent = 0;
    this.lastFrameReceived = -1;
    this.initNetworkParent();
    this.initPhysics();

    if (data.networkId === '') {
      data.networkId = NAF.utils.createNetworkId();
    }

    if (data.template != '') {
      this.initTemplate();
    }

    if (wasCreatedByNetwork) {
      this.firstUpdate();
      this.attachLerp();
    }

    if (this.data.owner === '') {
      var self = this;
      setTimeout(function() {
        self.checkLoggedIn();
      });
    }

    this.registerEntity(data.networkId);
  },

  wasCreatedByNetwork: function() {
    return !!this.el.firstUpdateData;
  },

  initNetworkParent: function() {
    var parentEl = this.el.parentElement;
    if (parentEl.hasOwnProperty('components') && parentEl.components.hasOwnProperty('networked')) {
      this.parent = parentEl;
    } else {
      this.parent = null;
    }
  },

  initPhysics: function() {
    var el = this.el;
    if (el.hasAttribute('networked-physics')) {
      this.physics = el.components['networked-physics'];
    } else {
      this.physics = null;
    }
  },

  hasPhysics: function() {
    return !!this.physics;
  },

  attachLerp: function() {
    if (NAF.options.useLerp) {
      this.el.setAttribute('lerp', '');
    }
  },

  registerEntity: function(networkId) {
    NAF.entities.registerEntity(networkId, this.el);
  },

  initTemplate: function() {
    var data = this.data;
    var showTemplate = !this.wasCreatedByNetwork() && data.showLocalTemplate;
    this.attachAndShowTemplate(data.template, data.showLocalTemplate);
  },

  attachAndShowTemplate: function(template, show) {
    var self = this;
    var el = this.el;
    var data = this.data;

    if (self.templateEl) {
      el.removeChild(self.templateEl);
    }

    var templateChild = document.createElement('a-entity');
    templateChild.setAttribute('template', 'src:' + template);
    templateChild.setAttribute('visible', show);

    el.appendChild(templateChild);
    self.templateEl = templateChild;

    if (self.hasPhysics()) {
      self.setupPhysicsTemplate(templateChild);
    }
  },

  setupPhysicsTemplate: function(templateChild) {
    var self = this;
    var el = this.el;

    templateChild.addEventListener('templaterendered', function () {
      var cloned = templateChild.firstChild;

      // mirror the attributes
      Array.prototype.slice.call(cloned.attributes || []).forEach(function (attr) {
        el.setAttribute(attr.nodeName, attr.nodeValue);
      });

      // take the children
      for (var child = cloned.firstChild; child; child = cloned.firstChild) {
        cloned.removeChild(child);
        el.appendChild(child);
      }

      cloned.pause();
      templateChild.pause();
      setTimeout(function() {
        try { templateChild.removeChild(cloned); } catch (e) {}
        try { el.removeChild(self.templateEl); } catch (e) {}
        delete self.templateEl;
      });
    });
  },

  firstUpdate: function() {
    var entityData = this.el.firstUpdateData;
    this.networkUpdate(entityData); // updates root element only
    this.waitForTemplateAndUpdateChildren();
  },

  waitForTemplateAndUpdateChildren: function() {
    var self = this;
    var callback = function() {
      var entityData = self.el.firstUpdateData;
      self.networkUpdate(entityData);
    };

    // wait for template to render (and monkey-patching to finish, so next tick), then callback
    if (this.templateEl) {
      this.templateEl.addEventListener('templaterendered', function() { setTimeout(callback); });
    } else {
      setTimeout(callback);
    }
  },

  checkLoggedIn: function() {
    if (NAF.clientId) {
      this.onLoggedIn();
    } else {
      this.listenForLoggedIn();
    }
  },

  listenForLoggedIn: function() {
    document.body.addEventListener('loggedIn', this.onLoggedIn, false);
  },

  onLoggedIn: function() {
    this.data.owner = NAF.clientId
    this.syncAll();
  },

  isMine: function() {
    return NAF.connection.isMineAndConnected(this.data.owner);
  },

  play: function() {
    this.bindEvents();
  },

  bindEvents: function() {
    var el = this.el;
    el.addEventListener('sync', this.syncDirty);
    el.addEventListener('syncAll', this.syncAll);
    el.addEventListener('networkUpdate', this.networkUpdateHandler);
  },

  pause: function() {
    this.unbindEvents();
  },

  unbindEvents: function() {
    var el = this.el;
    el.removeEventListener('sync', this.syncDirty);
    el.removeEventListener('syncAll', this.syncAll);
    el.removeEventListener('networkUpdate', this.networkUpdateHandler);
  },

  tick: function() {
    // if (!this.isPlayer()) {
    //   console.log('ismine', this.isMine());
    // }
    if (this.isMine() && this.needsToSync()) {
      this.syncDirty();
    }
  },

  isPlayer: function() {
    return this.el.getAttribute('id') == 'player';
  },


  /* Sending updates */

  syncAll: function(takeover) {
    this.updateNextSyncTime();
    var syncedComps = this.getAllSyncedComponents();
    var components = componentHelper.gatherComponentsData(this.el, syncedComps);
    var syncData = this.createSyncData(components, takeover);
    NAF.connection.broadcastDataGuaranteed('u', syncData);
    // console.error('syncAll', syncData);
    this.updateCache(components);
    this.framesSent += 1;
  },

  syncDirty: function() {
    this.updateNextSyncTime();
    var syncedComps = this.getAllSyncedComponents();
    var dirtyComps = componentHelper.findDirtyComponents(this.el, syncedComps, this.cachedData);
    if (dirtyComps.length == 0) {
      return;
    }
    var components = componentHelper.gatherComponentsData(this.el, dirtyComps);
    var syncData = this.createSyncData(components);
    if (NAF.options.compressSyncPackets) {
      syncData = Compressor.compressSyncData(syncData, syncedComps);
    }
    NAF.connection.broadcastData('u', syncData);
    // console.error('syncDirty', syncData);
    this.updateCache(components);
    this.framesSent += 1;
  },

  needsToSync: function() {
    return NAF.utils.now() >= this.nextSyncTime;
  },

  updateNextSyncTime: function() {
    this.nextSyncTime = NAF.utils.now() + 1000 / NAF.options.updateRate;
  },

  createSyncData: function(components, takeover) {
    var data = this.data;
    takeover = !!takeover;

    var sync = {
      0: 0, // 0 for not compressed
      networkId: data.networkId,
      owner: data.owner,
      template: data.template,
      parent: this.getParentId(),
      physics: this.getPhysicsData(),
      takeover: takeover,
      components: components,
      syncNum: this.framesSent,
    };
    return sync;
  },

  getPhysicsData: function() {
    if (this.hasPhysics()) {
      var physicsData = NAF.physics.getPhysicsData(this.el);
      if (physicsData) {
        physicsData.canLoseOwnership = this.physics.data.canLoseOwnership;
        return physicsData;
      } else {
        NAF.log.error('networked.getPhysicsData: Has networked-physics component but no aframe-physics-system component detected. el=', this.el, this.el.components);
      }
    }
    return null;
  },

  getParentId: function() {
    this.initNetworkParent(); // TODO fix calling this each network tick
    if (!this.parent) {
      return null;
    }
    var netComp = this.parent.getAttribute('networked');
    return netComp.networkId;
  },

  getAllSyncedComponents: function() {
    return NAF.schemas.getComponents(this.data.template);
  },

  updateCache: function(components) {
    for (var name in components) {
      this.cachedData[name] = components[name];
    }
  },


  /* Receiving updates */

  networkUpdateHandler: function(received) {
    var entityData = received.detail.entityData;
    this.networkUpdate(entityData);
  },

  networkUpdate: function(entityData) {
    if (entityData.syncNum < this.lastFrameReceived) {
      console.error('received frame num:', entityData.syncNum, 'last frame was ', this.lastFrameReceived);
    }
    this.lastFrameReceived = entityData.syncNum;

    if (entityData[0] == 1) {
      entityData = Compressor.decompressSyncData(entityData, this.data.components);
    }

    if (!this.hasPhysics() && entityData.physics) {
      if (!this.el.hasAttribute('networked-physics')) {
        var canLoseOwnership = entityData.physics.canLoseOwnership;
        this.el.setAttribute('networked-physics', { canLoseOwnership: canLoseOwnership} );
      }
      this.initPhysics();
    }
    if (this.hasPhysics()) {
      this.physics.networkUpdate(entityData);
    }

    if (entityData.components.hasOwnProperty('---material---color')) {
      // console.error('syncing material', entityData);
    }
    this.updateComponents(entityData.components);
  },

  updatePhysics: function(physics) {
    if (physics) {
      if (NAF.options.useLerp) {
        NAF.physics.attachPhysicsLerp(this.el, physics);
      } else {
        NAF.physics.detachPhysicsLerp(this.el);
        NAF.physics.updatePhysics(this.el, physics);
      }
    }
  },

  updateComponents: function(components) {
    var el = this.el;

    for (var key in components) {
      if (this.isSyncableComponent(key)) {
        var data = components[key];
        if (NAF.utils.isChildSchemaKey(key)) {
          var schema = NAF.utils.keyToChildSchema(key);
          var childEl = schema.selector ? el.querySelector(schema.selector) : el;
          if (childEl) { // Is false when first called in init
            if (schema.property) {
              childEl.setAttribute(schema.component, schema.property, data);
            }
            else {
              childEl.setAttribute(schema.component, data);
            }
          }
        } else {
          el.setAttribute(key, data);
        }
      }
    }
  },

  isSyncableComponent: function(key) {
    return true;
    // if (NAF.utils.isChildSchemaKey(key)) {
    //   var schema = NAF.utils.keyToChildSchema(key);
    //   return this.hasThisChildSchema(schema);
    // } else {
    //   return this.data.components.indexOf(key) != -1;
    // }
  },

  hasThisChildSchema: function(schema) {
    var schemaComponents = this.data.components;
    for (var i in schemaComponents) {
      var localChildSchema = schemaComponents[i];
      if (NAF.utils.childSchemaEqual(localChildSchema, schema)) {
        return true;
      }
    }
    return false;
  },

  remove: function () {
    if (this.isMine()) {
      var syncData = { networkId: this.data.networkId };
      NAF.connection.broadcastDataGuaranteed('r', syncData);
    }
  },
});
