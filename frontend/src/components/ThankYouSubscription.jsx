import React from "react";

export default function ThankYouSubscription() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-6">
      {/* Logo */}
      <img src="/logo.png" alt="GM Auto Detailing" className="w-32 mb-6" />

      {/* Title */}
      <h1 className="text-3xl font-bold text-green-600 mb-2">Thank you for subscribing!</h1>
      <h2 className="text-xl font-semibold text-gray-800 mb-6">Welcome!</h2>

      {/* Paragraph */}
      <p className="text-center text-gray-700 max-w-lg mb-8">
        We’re truly grateful you’ve joined our subscription family. We hope you enjoy your
        experience with GM Auto Detailing. Remember, you can cancel anytime if it’s not right for
        you — but we’re confident you’ll love the results.  
        <br />
        <br />
        As a subscriber, <strong>2 credits</strong> have now been added to your account. Use them
        whenever you like to book your next detail.
      </p>

      {/* Buttons */}
      <div className="flex gap-4">
        <a
          href="/?book=1"
          className="px-6 py-3 rounded-2xl bg-green-500 text-white font-semibold shadow-md hover:bg-green-600 transition"
        >
          Book Now
        </a>
        <a
          href="/account"
          className="px-6 py-3 rounded-2xl bg-blue-500 text-white font-semibold shadow-md hover:bg-blue-600 transition"
        >
          View Account
        </a>
      </div>
    </div>
  );
}
