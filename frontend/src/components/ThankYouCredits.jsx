import React from "react";

export default function ThankYouCredits() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-6">
      <img src="/logo.png" alt="GM Auto Detailing" className="w-32 mb-6" />

      <h1 className="text-3xl font-bold text-green-600 mb-2">Thank you for your booking!</h1>

      <p className="text-center text-gray-700 max-w-lg mb-8">
        Your booking has been confirmed using your available credits. We’ve deducted the credits
        from your balance and updated your account.  
        <br />
        <br />
        We hope you enjoy the convenience of our membership and the shine of your freshly detailed
        vehicle. Your satisfaction means the world to us.
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
