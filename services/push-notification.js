'use strict';

/**
 * push-notification.js service
 *
 * @description: A set of functions similar to controller's actions to avoid code duplication.
 */


const admin = require('firebase-admin'); // make sure firebase-admin is initialized


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

   async processPendingNotifications() {

	console.log("entered service ---------------->");
        await logger('Push notification processing started', 'START');

    try {
      const notifications = await strapi.query('notification-queue', 'push-notification').find({ status: 'pending' });
      console.log("notification queue data ---> ", notifications);

	 if (!notifications.length) {
            await logger('No pending notifications found', 'INFO');
            return;
      }

      for (const notif of notifications) {

	await logger(`Processing notification | id=${notif.id} | user=${notif.user_id}`, 'PROCESS');
        
	try {
          const fcmRecords = await strapi.query('fcm', 'push-notification').find({ userId: notif.userId, isActive: true }); 
	  console.log("fcm records --> ", fcmRecords);

          if (!fcmRecords || fcmRecords.length === 0) {

            await logger(
            `No FCM tokens | user=${notif.user_id} | notification=${notif.id}`,
            'WARN'
            );

            console.warn(`No tokens found for user ${notif.userId}`);
            continue;
          }

          const tokens = fcmRecords.map(r => r.token).filter(Boolean);

	  
          if (!tokens.length) {
                await logger(`Empty token list | user=${notif.user_id}`, 'WARN');
                continue;
          }

          const clickUrl = notif?.clickUrl || "https://myaccount-demo-dev.starberry.com"; 
	  console.log("click URL : ", clickUrl);

          // const icon = notif.data?.icon || "";
          const iconUrl = process.env.NOTIFICATION_ICON_URL || "https://ggfx-djalexander.s3.eu-west-2.amazonaws.com/i.dev/dja_logo_34d0dacf1a.jpg";
          const badge = process.env.NOTIFICATION_ICON_URL || "https://ggfx-djalexander.s3.eu-west-2.amazonaws.com/i.dev/dja_logo_34d0dacf1a.jpg";

	/*	
          const message = {
            notification: {
              title: notif.title,
              body: notif.body,
            },
            data: {
             click_action: clickUrl,
             icon: iconUrl,
	     badge: badge,	    
             ...notif.data 
            },
          };
       */

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
              strapi.query('fcm', 'push-notification').delete({ token: tokens[i] });
            }
          });

          await strapi.query('notification-queue', 'push-notification').update(
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


 async createNotificationQueue(data) {
    const { userId, title, body, clickUrl  } = data;
    if (!userId || !title || !body) {
      throw new Error('userId, title, and body are required');
    }

    return await strapi.query('notification-queue', 'push-notification').create({ userId, title, body, clickUrl, data: data.data || {}, status: 'pending', created_at: new Date() });
 },


 async sendPushNotification({ title, body, userId, clickUrl }) {
    try {
      if (!userId) {
        strapi.log.warn('Missing userId for push notification');
        return { success: false, message: 'Missing userId' };
      }

      const userTokens = await strapi.query('fcm', 'push-notification').find({ userId, isActive: true });
      if (!userTokens || userTokens.length === 0) {
        strapi.log.warn(`No tokens found for user: ${userId}`);
        return { success: false, message: 'No tokens found for this user' };
      }

      const tokens = userTokens.map(t => t.token).filter(Boolean);
      if (tokens.length === 0) {
        strapi.log.warn(`No valid tokens found for user: ${userId}`);
        return { success: false, message: 'No valid tokens found' };
      }

      const message = {
       // notification: { title, body },
	data: {
	 title: title,
	 body: body,
         icon: process.env.NOTIFICATION_ICON_URL || "",
         badge: process.env.NOTIFICATION_ICON_URL || "",
         click_action: clickUrl || "https://myaccount-demo-dev.starberry.com/",
       },     
        tokens,
      }

      const response = await admin.messaging().sendEachForMulticast(message);

      strapi.log.info(`Notification sent to user ${userId}: ${response.successCount} success, ${response.failureCount} failures`);
      return { success: true, response };

    } catch (error) {
      strapi.log.error('Error sending push notification:', error);
      return { success: false, message: error.message };
    }
  }



};
