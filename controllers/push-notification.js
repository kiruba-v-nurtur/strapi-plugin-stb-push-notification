'use strict';

/**
 * Read the documentation (https://strapi.io/documentation/v3.x/concepts/controllers.html#core-controllers)
 * to customize this controller
 */



'use strict';

const admin = require('firebase-admin'); // make sure firebase-admin is initialized
// const Token = strapi.models.token; // Mongo model if you want direct access
const UAParser = require('ua-parser-js');

const fs = require('fs');
const path = require('path');

let log_file;
let log_date;


const logger = async (content, flag = '') => {
 	console.log("entered logger ---> ");

  try {
    const today = new Date().toISOString().slice(0, 10);

    if (!log_file || log_date !== today) {
      log_date = today;

      const logDir = path.join(strapi.dir, '../log');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      log_file = fs.createWriteStream(
        `${logDir}/push-notification.${log_date}.log`,
        { flags: 'a' }
      );
    }

    const dt = new Date().toISOString();
    flag = flag ? `- ${flag} -` : '';

    log_file.write(`${dt} ${flag} ${content}\n`);
  } catch (err) {
    console.error('Logger error:', err);
  }
};




module.exports = {

 async sendNotification(ctx){
    try {
      const { title, body, userId, clickUrl } = ctx.request.body;

      const userToken = await strapi.query('fcm', 'push-notification').find({ userId, isActive: true });
      console.log("user token  : ", userToken);

      if (!userToken || !userToken.length === 0) {
        return ctx.badRequest('No tokens found for this user');
      }

     const tokens = userToken.map(t => t.token).filter(Boolean);
      console.log("all tokens : ", tokens);

      const message = {
      //  notification: { title, body },
	data: {
	 title: title,
	 body: body,
         icon: "https://ggfx-djalexander.s3.eu-west-2.amazonaws.com/i.dev/dja_logo_34d0dacf1a.jpg", 
         badge: "https://ggfx-djalexander.s3.eu-west-2.amazonaws.com/i.dev/dja_logo_34d0dacf1a.jpg",
         click_action: clickUrl || "https://myaccount-demo-dev.starberry.com/",
       },     
        tokens,
      };

      // For multiple devices
      const response = await admin.messaging().sendEachForMulticast(message);

      console.log('Successfully sent message:', response);
      ctx.send({ success: true, response });
    } catch (error) {
      console.error('Error sending message:', error);
      ctx.send({ success: false, error: error.message }, 500);
    }
  },

  async saveToken(ctx){
    try {
      const { token, userId } = ctx.request.body;

      const userAgent = ctx.request.headers['user-agent'];
      console.log("user agent : ", userAgent);

      const parser = new UAParser(userAgent);
      const result = parser.getResult();

      const browser = parser.getResult();
      const browserName = browser.browser?.name || 'Unknown';
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      console.log('Received token:', token);

      const existing = await strapi.query('fcm', 'push-notification').findOne({ token });
      console.log("existing --> ", existing);

       if (existing) {
        await strapi.query('fcm', 'push-notification').update(
          { id: existing.id },
          { expiresAt, isActive: true }
        );

        return ctx.send({ success: true, message: 'Token refreshed', browser: browserName });
      }

      await strapi.query('fcm', 'push-notification').create({
        userId,
        token,
        browser: browserName,
        expiresAt,
        isActive: true,
      });


     await strapi.plugins['push-notification'].services['push-notification'].sendPushNotification({
          title: 'Token Registered',
          body: 'Your device has been registered for notifications.',
          userId,
        });


      ctx.send({ success: true, message: 'Token saved successfully' });
    } catch (error) {
      console.error('Error saving token:', error);
      ctx.throw(500, error.message); 	    
    }
  },



   async processPendingNotifications() {

     await logger('Push notification processing started', 'START');

    try {
      const notifications = await strapi.query('notification-queue').find({ status: 'pending' });
    
      if (!notifications.length) {
     	    await logger('No pending notifications found', 'INFO');
	    return;
      }

      for (const notif of notifications) {

	   await logger(`Processing notification | id=${notif.id} | user=${notif.user_id}`, 'PROCESS');


        try {
          const fcmRecords = await strapi.query('fcm', 'push-notification').find({ user_id: notif.user_id, isActive: true });
          if (!fcmRecords || fcmRecords.length === 0) {
	
	    await logger(
            `No FCM tokens | user=${notif.user_id} | notification=${notif.id}`,
            'WARN'
            );	

            console.warn(`No tokens found for user ${notif.user_id}`);
            continue;
          }

          const tokens = fcmRecords.map(r => r.token).filter(Boolean);
          
	  if (!tokens.length) {
		await logger(`Empty token list | user=${notif.user_id}`, 'WARN');
		continue;
	  }

	  const clickUrl = notif.data?.clickUrl || "";
         // const icon = notif.data?.icon || "";
          const iconUrl = process.env.NOTIFICATION_ICON_URL || "";

	
          const message = {
               data: {
                        title: notif.title,
                        body: notif.body,
                        click_action: clickUrl,
                        icon: iconUrl,
                        badge: badge,
                        ...notif.data
                   },
           };

	

          const response = await admin.messaging().sendEachForMulticast({
            tokens,
            ...message,
          });

          // Optional cleanup for invalid tokens
          response.responses.forEach((res, i) => {
            if (!res.success) {

	     // await logger(`FCM send failed | token=${tokens[i]} | error=${res.error?.message}`, 'ERROR');

              strapi.query('fcm').delete({ fcm_token: tokens[i] });
            }
          });

          await strapi.query('notification-queue').update(
            { id: notif.id },
            {
              status: response.failureCount === 0 ? 'sent' : 'partial',
              sent_at: new Date(),
            }
          );

	  await logger(`Notification sent | id=${notif.id} | user=${notif.user_id} | success=${response.successCount} | failed=${response.failureCount}`, 'SUCCESS');

          console.log(
            `Notification sent to user ${notif.user_id} (${response.successCount} success, ${response.failureCount} failed)`
          );
        } catch (err) {
          await logger(`Notification failed | id=${notif.id} | error=${err.message}`, 'FAILED');
          console.error(`Error processing notification ${notif.id}:`, err);
          await strapi.query('notification-queue').update({ id: notif.id }, { status: 'failed' });
        }
      }
    } catch (err) {
      await logger(`Notification queue crashed | error=${err.message}`, 'FATAL');
      console.error('Notification queue error:', err);
    }
      await logger('Push notification processing finished', 'END');
  },


 async createNotificationQueue(ctx) {
    try {
      const record = await strapi.plugins['push-notification'].services['push-notification'].createNotificationQueue(ctx.request.body);
      ctx.send({ success: true, data: record });
    } catch (err) {
      ctx.badRequest(err.message);
    }
  },


};
