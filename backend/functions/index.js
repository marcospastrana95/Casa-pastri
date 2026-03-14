const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
// Use Secret Manager for the Stripe Secret Key
const stripeModule = require("stripe");
const nodemailer = require("nodemailer");
const ical = require("node-ical");
const cors = require('cors')({ origin: true });


admin.initializeApp();

/**
 * Creates a Stripe Checkout Session for 30% of the total price.
 * Saves the payment method for future off-session use (70% remaining).
 */
exports.createCheckoutSession = functions.runWith({ secrets: ["STRIPE_SECRET"] }).https.onRequest((req, res) => {
  cors(req, res, async () => {
    const stripe = stripeModule(process.env.STRIPE_SECRET);
    try {
      // Compatibility adjustment since we moved to onRequest for CORS control
      const data = req.body.data || req.body; 
      const { bookingId, totalPrice, successUrl, cancelUrl } = data;

      const bookingDoc = await admin.firestore().collection("bookings").doc(bookingId).get();
      if (!bookingDoc.exists) {
        return res.status(404).send({ error: "Booking not found" });
      }

      const bookingData = bookingDoc.data();
      
      // Safety check for parsing "123€" or similar string values into cents
      let parsedPrice = parseInt(String(totalPrice).replace(/[^\d]/g, ""), 10);
      if (isNaN(parsedPrice) || parsedPrice <= 0) {
          console.error("Invalid total price provided:", totalPrice);
          return res.status(400).send({ error: "Invalid pricing data" });
      }
      
      const totalAmountInCents = parsedPrice * 100;

      // Determine if check-in is within 10 days → charge 100%
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const checkInDate = new Date(bookingData.checkIn + "T00:00:00");
      const daysUntilCheckIn = Math.ceil((checkInDate - today) / (1000 * 60 * 60 * 24));
      const isFullPayment = daysUntilCheckIn <= 10;

      let chargeAmountInCents, depositAmountInCents, remainingAmountInCents;
      let productName, productDescription;

      if (isFullPayment) {
        // Full payment — no future charge needed
        chargeAmountInCents = totalAmountInCents;
        depositAmountInCents = totalAmountInCents;
        remainingAmountInCents = 0;
        productName = `Reserva Casa Pastri (Pago Total) - ${bookingData.checkIn} al ${bookingData.checkOut}`;
        productDescription = `Pago completo de la estancia: ${totalPrice}. Al reservar con menos de 10 días de antelación, se cobra el 100% del importe.`;
      } else {
        // 30% Deposit
        depositAmountInCents = Math.round(totalAmountInCents * 0.30);
        chargeAmountInCents = depositAmountInCents;
        remainingAmountInCents = totalAmountInCents - depositAmountInCents;
        productName = `Reserva Casa Pastri (Señal 30%) - ${bookingData.checkIn} al ${bookingData.checkOut}`;
        productDescription = `Total estancia: ${totalPrice}. Paga ahora el 30% como señal. El 70% restante (${remainingAmountInCents / 100}€) se cobrará automáticamente 10 días antes del check-in. IMPORTANTE: En caso de que el cobro automático falle, la reserva será cancelada y se perderá la señal del 30%.`;
      }

      // Build session config
      const sessionConfig = {
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "eur",
              product_data: {
                name: productName,
                description: productDescription,
              },
              unit_amount: chargeAmountInCents,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: bookingData.email,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          bookingId: bookingId,
          totalAmountInCents: totalAmountInCents.toString(),
          depositAmountInCents: depositAmountInCents.toString(),
          remainingAmountInCents: remainingAmountInCents.toString(),
          paymentType: isFullPayment ? "full" : "deposit",
        },
      };

      // Only save payment method for future charges if it's a deposit
      if (!isFullPayment) {
        sessionConfig.payment_intent_data = {
          setup_future_usage: "off_session",
        };
      }

      const session = await stripe.checkout.sessions.create(sessionConfig);

      return res.status(200).send({ data: { sessionId: session.id, url: session.url } });
    } catch (error) {
      console.error("Stripe Error:", error);
      return res.status(500).send({ error: error.message });
    }
  });
});

/**
 * Webhook to handle successful payments and link Stripe Customer/Payment Method to Booking
 */
exports.stripeWebhook = functions.runWith({ secrets: ["STRIPE_SECRET", "SMTP_HOST", "SMTP_USER", "SMTP_PASS"] }).https.onRequest(async (req, res) => {
  const stripe = stripeModule(process.env.STRIPE_SECRET);
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    // Note: You should set the endpoint secret in your env
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
  } catch (err) {
    console.error(`Webhook Signature Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const bookingId = session.metadata.bookingId;

    // Retrieve the PaymentIntent to get the PaymentMethod ID
    const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);

    const isFullPayment = session.metadata.paymentType === "full";
    const updateData = {
      status: isFullPayment ? "fully_paid" : "deposit_paid",
      stripe_customer_id: session.customer,
      stripe_payment_method_id: paymentIntent.payment_method,
      paid_at: admin.firestore.FieldValue.serverTimestamp(),
      remaining_amount: parseInt(session.metadata.remainingAmountInCents) / 100,
      remaining_amount_cents: parseInt(session.metadata.remainingAmountInCents),
      payment_type: session.metadata.paymentType,
    };
    if (isFullPayment) {
      updateData.fully_paid_at = admin.firestore.FieldValue.serverTimestamp();
    } else {
      updateData.deposit_paid_at = admin.firestore.FieldValue.serverTimestamp();
    }
    await admin.firestore().collection("bookings").doc(bookingId).update(updateData);

    // --- Send Confirmation Emails ---
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 465,
        secure: true,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const bookingDoc = await admin.firestore().collection("bookings").doc(bookingId).get();
      const b = bookingDoc.data();

      // 1. Email to Customer
      await transporter.sendMail({
        from: '"Casa Pastri" <noreply@casapastri.com>',
        to: b.email,
        subject: "¡Reserva Confirmada en Casa Pastri!",
        html: `
          <h1>¡Hola ${b.name}!</h1>
          <p>Tu reserva en Casa Pastri (La Graciosa) ha sido confirmada tras el pago de la señal.</p>
          <p><strong>Detalles:</strong></p>
          <ul>
            <li>Entrada: ${b.checkIn}</li>
            <li>Salida: ${b.checkOut}</li>
            <li>Huéspedes: ${b.guests}</li>
            <li>Total Estancia: ${b.totalPrice}</li>
          </ul>
          <p>Hemos cargado el 30% como señal. El 70% restante (${b.remaining_amount}€) se cobrará automáticamente 10 días antes de tu llegada.</p>
          <p><em>Recuerda que si el cobro automático por falta de fondos o tarjeta caducada falla, la reserva se cancelará y se perderá la señal.</em></p>
          <p>¡Te esperamos!</p>
        `,
      });

      // 2. Email to Owner
      await transporter.sendMail({
        from: '"Casa Pastri Web" <noreply@casapastri.com>',
        to: "marcospastrana95@gmail.com", // Adjust as needed
        subject: `Nueva Reserva: ${b.name} (${b.checkIn})`,
        html: `
          <h2>Nueva reserva confirmada (Señal pagada)</h2>
          <p><strong>Cliente:</strong> ${b.name} (${b.email})</p>
          <p><strong>Fechas:</strong> ${b.checkIn} al ${b.checkOut}</p>
          <p><strong>Total:</strong> ${b.totalPrice}</p>
          <p>El 70% restante se cobrará automáticamente 10 días antes.</p>
        `,
      });
    } catch (emailError) {
      console.error("Error sending emails:", emailError);
    }

  }

  res.json({ received: true });
});

/**
 * Scheduled function to charge the remaining 70% exactly 10 days before check-in
 * Runs daily at midnight
 */
exports.autoChargeRemainingBalance = functions.runWith({ secrets: ["STRIPE_SECRET"] }).pubsub.schedule('0 0 * * *')
  .timeZone('Atlantic/Canary')
  .onRun(async (context) => {
    const stripe = stripeModule(process.env.STRIPE_SECRET);
    const today = new Date();
    const targetDate = new Date();
    targetDate.setDate(today.getDate() + 10);
    const targetDateStr = targetDate.toISOString().split('T')[0];

    const snapshot = await admin.firestore().collection("bookings")
      .where("checkIn", "==", targetDateStr)
      .where("status", "==", "deposit_paid")
      .get();

    const charges = snapshot.docs.map(async (doc) => {
      const data = doc.data();
      try {
        await stripe.paymentIntents.create({
          amount: data.remaining_amount_cents,
          currency: "eur",
          customer: data.stripe_customer_id,
          payment_method: data.stripe_payment_method_id,
          off_session: true,
          confirm: true,
          description: `Cobro restante (70%) para reserva de ${data.name} (${data.checkIn})`,
        });

        await doc.ref.update({ status: "fully_paid", fully_paid_at: admin.firestore.FieldValue.serverTimestamp() });
        console.log(`Successfully charged remaining balance for booking ${doc.id}`);
      } catch (err) {
        console.error(`Failed to charge booking ${doc.id}:`, err.message);
        await doc.ref.update({ status: "payment_failed", last_error: err.message });
      }
    });

    await Promise.all(charges);
    return null;
  });

/**
 * Sync Calendar with Booking.com iCal
 * Runs every 4 hours automatically
 */
exports.syncBookingCalendar = functions.runWith({ timeoutSeconds: 60 }).pubsub.schedule('0 */4 * * *')
  .timeZone('Atlantic/Canary')
  .onRun(async (context) => {
    return runSyncBookingCalendar();
  });

/**
 * Manual HTTP trigger for syncing the calendar
 */
exports.syncBookingCalendarHTTP = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      await runSyncBookingCalendar();
      return res.status(200).send({ data: { success: true } });
    } catch (e) {
      console.error(e);
      return res.status(500).send({ data: { error: e.message } });
    }
  });
});

async function runSyncBookingCalendar() {
  const iCalUrl = "https://ical.booking.com/v1/export/t/2237854f-9efb-4fd2-a4c1-cf7844bd7c60.ics";
  
  try {
    console.log("Starting Booking.com iCal sync...");
    const events = await ical.async.fromURL(iCalUrl);
    
    const blockedDatesSet = new Set();
    
    for (const key in events) {
      if (!Object.hasOwn(events, key)) continue;
      const ev = events[key];
      
      if (ev.type === "VEVENT") {
        let current = new Date(ev.start);
        const end = new Date(ev.end);
        
        while (current < end) {
          const ds = current.toISOString().split("T")[0];
          blockedDatesSet.add(ds);
          current.setDate(current.getDate() + 1);
        }
      }
    }
    
    const bookingComDates = Array.from(blockedDatesSet);
    
    // Save these dates to the specific array in Firestore
    const docRef = admin.firestore().collection("config").doc("availability");
    await docRef.set({ bookingComDates }, { merge: true });
    
    console.log(`Synced ${bookingComDates.length} blocked dates from Booking.com`);
    return true;
  } catch (error) {
    console.error("Error syncing iCal:", error);
    throw error;
  }
}

/**
 * Automatically send email when booking is cancelled
 */
exports.onBookingUpdate = functions.runWith({ secrets: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"] })
  .firestore.document('bookings/{bookingId}')
  .onUpdate(async (change, context) => {
    const newData = change.after.data();
    const oldData = change.before.data();

    // Check if status changed to cancelled
    if (newData.status === "cancelled" && oldData.status !== "cancelled") {
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: 465,
          secure: true,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        await transporter.sendMail({
          from: '"Casa Pastri" <noreply@casapastri.com>',
          to: newData.email,
          subject: "Reserva Cancelada - Casa Pastri",
          html: `
            <h1>Hola ${newData.name},</h1>
            <p>Te informamos que tu reserva para las fechas <strong>${newData.checkIn}</strong> al <strong>${newData.checkOut}</strong> ha sido cancelada.</p>
            <p>Si tienes alguna duda, por favor contacta con nosotros respondiendo a este correo.</p>
            <p>Atentamente,<br>El equipo de Casa Pastri</p>
          `,
        });
        console.log(`Cancellation email sent to ${newData.email}`);

        // Unlock dates in availability document
        const datesToRemove = [];
        let cursor = new Date(newData.checkIn);
        const end = new Date(newData.checkOut);
        while (cursor < end) {
          datesToRemove.push(cursor.toISOString().split('T')[0]);
          cursor.setDate(cursor.getDate() + 1);
        }

        if (datesToRemove.length > 0) {
          const availRef = admin.firestore().collection("config").doc("availability");
          await availRef.update({
            reservedDates: admin.firestore.FieldValue.arrayRemove(...datesToRemove)
          });
          console.log(`Unlocked ${datesToRemove.length} dates for cancelled booking ${context.params.bookingId}`);
        }
      } catch (error) {
        console.error("Error in onBookingUpdate cancellation:", error);
      }
    }
  });

