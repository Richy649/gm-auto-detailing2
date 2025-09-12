import React from "react";

export default function ThankYouOneOff() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-6">
      <img src="/logo.png" alt="GM Auto Detailing" className="w-32 mb-6" />

      <h1 className="text-3xl font-bold text-green-600 mb-2">Thank you for your booking!</h1>

      <p className="text-center text-gray-700 max-w-lg mb-8">
        We’re excited to have the opportunity to care for your vehicle. Your booking is confirmed,
        and we’ll make sure everything is ready for you.  
        <br />
        <br />
        We truly appreciate your trust in us — we’ll do everything we can to make sure you love the
        results.
      </p>

      <a
        href="/account"
        className="px-6 py-3 rounded-2xl bg-blue-500 text-white font-semibold shadow-md hover:bg-blue-600 transition"
      >
        View Account
      </a>
    </div>
  );
}
